#!/usr/bin/env node
/** D6 independent four-case UI/HTTP/disk evidence. No result exists until this script actually runs. */
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
import { validateDefectTicketDecision } from '../src/acceptance/defect-ticket-schema.mjs';
import { createDefectTicketDecisionRelay } from './fixtures/defect-ticket-decision-relay.mjs';
import { browserResolutionDelay as delay } from './fixtures/browser-resolution-stream.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace/_runs/defect-ticket-decisions-console-smoke-' + randomUUID()));
assert(process.argv.length <= 3); assert.equal(fs.existsSync(OUT), false, 'Use a fresh evidence directory.');
fs.mkdirSync(OUT, { recursive: true }); const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance'); fs.mkdirSync(DATA);
const token = 'd6-controlled-local-fixture', headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const startedAt = new Date().toISOString(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const save = (name, value) => fs.writeFileSync(join(OUT, name), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8')), cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const checks = {}, cases = [], captures = [], layouts = [], browserRequests = [], browserResponses = [], pageErrors = [], consoleMessages = [], targetRequests = [];
const requestRecords = new WeakMap(), responseReads = new Set(), responseReadPromises = new Map();
const transportResponses = new Map();
const cdpNetwork = [], playwrightCompletions = [];
const ingressScope = join(OUT, 'ingress-scope.json'), ingressLog = join(OUT, 'ingress.jsonl'), relayLog = join(OUT, 'relay.jsonl');
fs.writeFileSync(ingressScope, '{}\n'); fs.writeFileSync(ingressLog, ''); fs.writeFileSync(relayLog, '');
let engine, browser, chromiumProcess, context, page, target, relay, engineBase, uiBase, targetBase, project, candidate, source;
let sourceAvailable = true, engineLog = '', chromiumLog = '', failure, sourceBytes, sourceRequestsBeforeUnavailable, selected, bad, healthy;
let implementationInputs;
const requiredChecks = ['realCapturedSource', 'registeredTwoFixedFailures', 'registeredHealthyTwoMembers', 'fourUniqueOriginalActions',
  'realUIOriginsAndReceiptScope', 'sameUniqueUpstreamBodyPerCase', 'denyAndAcceptedMutuallyExclusive',
  'noTargetOrSourceOrBrowserOrCatalogSideEffects', 'sourceOriginalBytesRemain', 'pendingLayoutsDesktopMobile',
  'onlyExactControlledHttp502Errors', 'implementationInputsUnchanged', 'fourCompleteCases'];
const caseCheckNames = ['uiOriginalBound', 'prefixObservedBeforeDownstream502', 'controlled502FinishedNormally',
  'unknownRetainsFullOriginal', 'readOnlyUnresolvedPreservesOriginal', 'manualDenyBoundExact', 'winnerOrderingProved',
  'completeProofMatchesDisk', 'lateOriginalMatchesWinningDecision', 'oneUpstreamRequestAndBodyEnd', 'oneDenyRequestAndOneForward',
  'pendingReleasedAfterProof', 'uiOutcomeAndDraft', 'ticketEffectMatchesWinner', 'sideEffectsUnchanged',
  'decisionTreeOnlyExpectedAddition', 'postGetMatchesWinner'];
function check(name) { assert(requiredChecks.includes(name)); checks[name] = true;
  fs.writeFileSync(join(OUT, 'progress.json'), JSON.stringify({ at: new Date().toISOString(), checks, cases }, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'check', name, passed: true, at: new Date().toISOString() })); }
async function waitFor(fn, label, budget = 65000) {
  const until = Date.now() + budget; let last;
  while (Date.now() < until) { try { const value = await fn(); if (value) return value; } catch (cause) { last = cause; } await delay(100); }
  throw Error(label + ': ' + (last?.message ?? 'state not reached'), { cause: last });
}
async function bounded(promise, label, budget = 25000) {
  let timer; try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(label)), budget); })]); }
  finally { clearTimeout(timer); }
}
async function listen(server) { await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); }); return 'http://127.0.0.1:' + server.address().port; }
async function close(server) { if (server?.listening) await new Promise(ready => { server.close(ready); server.closeAllConnections(); }); }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exit, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
}
async function api(path, body, status = 200) {
  const response = await fetch(engineBase + '/api/acceptance/' + path, { headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const payload = await response.json(); fs.appendFileSync(join(OUT, 'http.jsonl'), JSON.stringify({ method: body === undefined ? 'GET' : 'POST', path,
    ...(body === undefined ? {} : { body }), status: response.status, payload }) + '\n');
  assert.equal(response.status, status, path + ': ' + JSON.stringify(payload)); return payload;
}
const latest = () => api('projects'), ticketPath = () => 'projects/' + project.id + '/defect-tickets';
const fullTicketPath = () => '/api/acceptance/' + ticketPath(), executionPath = () => 'projects/' + project.id + '/browser-executions';
/**
 * 读取某个 action 响应的 JSON 体。
 *
 * Chromium 偶尔会在应用已经消费完整 JSON 后把网络条目标记为 ERR_ABORTED，此时 Playwright
 * 的 getResponseBody 会报 "navigated away"。动作 GET 和人工 deny POST 的 canonical body
 * 因此取自同源 Relay 的完整响应帧，再用浏览器请求记录、状态码和响应体（若仍可读）交叉核对。
 */
async function reconcileActionResponseBody(item, relayed) {
  assert(Buffer.isBuffer(relayed.rawBody) && relayed.payload !== null, 'relay action response has a complete body');
  assert.equal(relayed.bodySha256, hash(relayed.rawBody));
  assert.equal(item.method, relayed.method);
  assert.equal(item.path, new URL(relayed.path, 'http://relay.invalid').pathname);
  assert.equal(item.status, relayed.status);
  await responseReadPromises.get(item.requestId);
  const downstream = await waitFor(() => lines(relayLog).find(value => value.event === 'action-response-downstream-finish'
    && value.method === relayed.method && value.path === relayed.path && value.status === relayed.status
    && value.bodySha256 === relayed.bodySha256));
  assert.equal(downstream.writableEnded, true); assert.equal(downstream.writableFinished, true);
  if (item.rawBody !== undefined) {
    assert.equal(item.bodySha256, relayed.bodySha256);
    assert.deepEqual(Buffer.from(item.rawBody), relayed.rawBody);
  }
  if (item.readFailure) item.browserBodyReadFailure = item.readFailure;
  item.downstreamResponseFinished = true;
  item.bodySource = 'relay-complete-action-response';
  item.rawBody = relayed.rawBody.toString('utf8');
  item.bodySha256 = relayed.bodySha256;
  item.payload = relayed.payload;
  delete item.readFailure;
  return item.payload;
}
async function actionResponsePayload(response, relayStart) {
  // page.waitForResponse 给的是 Response；requestRecords 的键是 Request，要先取回来。
  const id = requestRecords.get(response.request())?.id;
  assert.ok(id, 'action response was not recorded by the browser listener');
  const item = await waitFor(() => browserResponses.find(value => value.requestId === id));
  const url = new URL(response.url());
  const relayed = await waitFor(() => relay.replies.slice(relayStart).find(value => value.method === response.request().method()
    && value.path === url.pathname && value.status === response.status() && value.payload !== null));
  assert.equal(relayed.bodySha256, hash(relayed.rawBody));
  return reconcileActionResponseBody(item, relayed);
}
const component = () => page.getByTestId('defect-tickets'), panel = () => page.getByTestId('acceptance-catalog');
const uiPosts = () => browserRequests.filter(value => value.method === 'POST' && value.path.startsWith(fullTicketPath()));
const lines = path => fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(value => JSON.parse(value));
function tree(root) {
  if (!fs.existsSync(root)) return {};
  const output = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(tree(path))) output[entry.name + '/' + name] = value;
    else { assert(entry.isFile()); const bytes = fs.readFileSync(path); output[entry.name] = { bytes: bytes.length, sha256: hash(bytes) }; }
  }
  return output;
}
const originals = () => ({ catalog: hash(fs.readFileSync(join(ROOT, 'catalog.json'))), browser: tree(join(ROOT, 'browser-operations')),
  source: tree(join(ROOT, source.runId)) });
function inputSnapshot() {
  const files = ['src/acceptance/defect-ticket-schema.mjs', 'src/acceptance/defect-ticket-store.mjs', 'src/acceptance/defect-ticket-service.mjs',
    'src/acceptance/defect-ticket-api.mjs', 'src/engine-server.mjs', '../console/src/acceptance-defect-tickets.js', '../console/src/AcceptanceDefectTickets.vue',
    'scripts/smoke-acceptance-defect-ticket-decisions-console.mjs', 'scripts/fixtures/defect-ticket-decision-relay.mjs',
    'scripts/fixtures/defect-ticket-decision-ingress.mjs', 'scripts/fixtures/browser-resolution-stream.mjs', 'scripts/verify-acceptance-defect-ticket-decisions-console.mjs'];
  return { sources: Object.fromEntries(files.map(file => { const bytes = fs.readFileSync(resolve(CORE, file)); return [file, { bytes: bytes.length, sha256: hash(bytes) }]; })),
    consoleBundle: tree(resolve(CORE, '../console/dist')) };
}
function html({ broken = false } = {}) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>D6 controlled acceptance</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial;background:#eef2f6;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;justify-content:space-between}main{max-width:900px;padding:24px;margin:auto}button,input{font:inherit;padding:8px}.panel{height:250px;padding:24px;border:1px solid #bbc9d7;background:' + (broken ? '#8d2b10;color:white;transform:translateY(60px)' : 'white') + '}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}input{max-width:100%}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Fixed manual defect members</h1><nav id="menu" hidden>Expanded navigation</nav><section class="panel"><h2>Captured approved source</h2><label>Test entry <input id="entry"></label><p id="literal">d6-captured-source-sentinel</p></section></main><script>document.querySelector("#menu-toggle").addEventListener("click",function(){' + (broken ? 'return;' : 'const menu=document.querySelector("#menu");menu.hidden=!menu.hidden;this.setAttribute("aria-expanded",String(!menu.hidden))') + '})</script></body></html>';
}
async function startEngine() {
  const socket = createServer(); engineBase = await listen(socket); await close(socket);
  engine = spawn(process.execPath, ['--import', new URL('./fixtures/defect-ticket-decision-ingress.mjs', import.meta.url).href,
    'src/engine-server.mjs', new URL(engineBase).port], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'), HEIMDALL_HOST: '127.0.0.1',
      HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0', HEIMDALL_DEFECT_TICKET_DECISION_INGRESS_SCOPE: ingressScope,
      HEIMDALL_DEFECT_TICKET_DECISION_INGRESS_LOG: ingressLog }, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = engine; child.stdout.on('data', bytes => { engineLog += bytes; }); child.stderr.on('data', bytes => { engineLog += bytes; });
  await waitFor(async () => { if (child.exitCode !== null) throw Error(engineLog); return (await fetch(engineBase + '/api/status', { headers })).ok; }, 'engine ready');
  relay = createDefectTicketDecisionRelay({ engineBase, scopeFile: ingressScope, logFile: relayLog }); uiBase = await listen(relay.server);
  assert(!['5173', '5174', '5175'].includes(new URL(uiBase).port), 'UI relay must retain the real same-origin API path.');
}
async function startBrowser() {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; }); chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const active = join(profile, 'DevToolsActivePort'); await waitFor(() => fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0], 'CDP ready');
  const cdp = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0]; save('cdp-version.json', await (await fetch(cdp + '/json/version')).json());
  browser = await chromium.connectOverCDP(cdp); context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('heimdall-token', value); }, token);
  page = await context.newPage(); page.setDefaultTimeout(60000);
  const network = await context.newCDPSession(page), networkRequests = new Map(); await network.send('Network.enable');
  network.on('Network.requestWillBeSent', value => { if (new URL(value.request.url).pathname.startsWith('/api/acceptance/')) {
    networkRequests.set(value.requestId, value.request.url); cdpNetwork.push({ at: new Date().toISOString(), event: 'request', requestId: value.requestId,
      url: value.request.url, method: value.request.method, ...(value.request.postData === undefined ? {} : { bodySha256: hash(Buffer.from(value.request.postData)) }) }); } });
  network.on('Network.responseReceived', value => { if (networkRequests.has(value.requestId)) cdpNetwork.push({ at: new Date().toISOString(), event: 'response', requestId: value.requestId,
    url: networkRequests.get(value.requestId), status: value.response.status, headers: value.response.headers }); });
  network.on('Network.loadingFinished', value => { if (networkRequests.has(value.requestId)) cdpNetwork.push({ at: new Date().toISOString(), event: 'finished', requestId: value.requestId,
    url: networkRequests.get(value.requestId), encodedDataLength: value.encodedDataLength }); });
  network.on('Network.loadingFailed', value => { if (networkRequests.has(value.requestId)) cdpNetwork.push({ at: new Date().toISOString(), event: 'failed', requestId: value.requestId,
    url: networkRequests.get(value.requestId), errorText: value.errorText, canceled: value.canceled }); });
  page.on('pageerror', cause => pageErrors.push(cause.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), location: message.location(), caseId: relay.cases.at(-1)?.caseId ?? null }); });
  page.on('request', request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith('/api/acceptance/')) return;
    const bytes = request.postDataBuffer(), record = { id: 'ui-' + randomUUID(), method: request.method(), origin: url.origin, path: url.pathname,
      url: request.url(), ...(bytes ? { rawBody: bytes.toString('utf8'), bytes: bytes.length, bodySha256: hash(bytes), body: JSON.parse(bytes) } : {}), finished: false, failed: null };
    requestRecords.set(request, record); browserRequests.push(record);
  });
  page.on('requestfinished', request => { const record = requestRecords.get(request); playwrightCompletions.push({ at: new Date().toISOString(), event: 'finished', requestId: record?.id ?? null, url: request.url(), mapped: !!record }); if (record) record.finished = true; });
  page.on('requestfailed', request => { const record = requestRecords.get(request); playwrightCompletions.push({ at: new Date().toISOString(), event: 'failed', requestId: record?.id ?? null, url: request.url(), mapped: !!record, failure: request.failure() }); if (record) record.failed = request.failure(); });
  page.on('response', response => {
    const record = requestRecords.get(response.request()); if (!record) return;
    transportResponses.set(record.id, response);
    const item = { requestId: record.id, origin: record.origin, path: record.path, method: record.method, status: response.status() }; browserResponses.push(item);
    if (/\/defect-tickets\/actions\//.test(record.path)) {
      const read = response.body().then(bytes => { item.rawBody = bytes.toString('utf8'); item.bodySha256 = hash(bytes); item.payload = JSON.parse(bytes); }).catch(cause => { item.readFailure = cause.message; });
      responseReads.add(read); responseReadPromises.set(record.id, read); read.finally(() => responseReads.delete(read));
    }
  });
}
async function openConsole() {
  await page.goto(uiBase, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await panel().getByTestId('catalog-toggle').click(); await panel().locator('[name="catalog-project"]').selectOption(project.id);
  await component().waitFor(); await waitFor(async () => !(await panel().getByTestId('catalog-refresh').isDisabled()), 'catalog ready');
  await component().getByTestId('defect-tickets-toggle').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('heimdall-api')), null); assert.equal(new URL(page.url()).origin, uiBase);
}
async function operation(release, beforeOperationId = null) {
  const input = { ...cas(await latest()), operationId: 'bo-' + randomUUID(), candidateId: candidate.id, contentDigest: candidate.contentDigest, targetReleaseId: release.id };
  await api(executionPath(), input, 202);
  await waitFor(async () => { const value = await api(executionPath() + '/' + input.operationId); return value.state === 'completed' && value; }, 'real completed Browser operation', 90000);
  const report = await api(executionPath() + '/' + input.operationId + '/report');
  await api(executionPath() + '/' + input.operationId + '/register-result', beforeOperationId ? { beforeOperationId } : {}); return { input, report };
}
async function refreshTicket(ticketId) {
  await component().getByTestId('defect-tickets-refresh').click(); await waitFor(async () => !(await component().getByTestId('defect-tickets-refresh').isDisabled()), 'ticket list refreshed');
  const button = component().locator('[data-testid="defect-ticket-open"][data-ticket-id="' + ticketId + '"]');
  await waitFor(async () => await button.count() === 1 && !(await button.isDisabled()), 'exact ticket available'); await button.click();
  await waitFor(async () => (await component().getByTestId('defect-ticket-detail').innerText()).includes(ticketId), 'exact detail rendered');
}
async function previewClose(afterOperationId) {
  await component().getByTestId('defect-ticket-preview').click();
  await waitFor(async () => await component().getByTestId('defect-ticket-after').innerText() === afterOperationId, 'latest fixed close preview');
}
async function storage() {
  const key = `heimdall:defect-tickets:v1:${uiBase}:${project.id}`;
  return page.evaluate(key => { const raw = localStorage.getItem(key); return { key, raw, values: raw === null ? [] : JSON.parse(raw) }; }, key);
}
async function draftSnapshot() {
  const value = {};
  for (const key of ['title', 'severity', 'description', 'reproduction', 'resolution']) {
    const field = component().getByTestId('defect-ticket-' + key); value[key] = await field.count() ? await field.inputValue() : '';
  }
  value.memberCheckIds = await component().getByTestId('defect-ticket-member').evaluateAll(elements => elements.filter(value => value.checked).map(value => value.dataset.checkId).sort());
  return value;
}
async function ticketSnapshot(ticketId, exists = true) {
  const detail = await api(ticketPath() + '/' + ticketId, undefined, exists ? 200 : 404);
  if (!exists) return { absent: true, code: detail.code };
  const artifact = await api(ticketPath() + '/' + ticketId + '/export.json'); delete artifact.exportedAt;
  return { ticket: detail.ticket, artifact };
}
async function capture(name, width, height, theme, pending = false) {
  await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const anchor = component().getByTestId(pending ? 'defect-ticket-pending' : 'defect-ticket-detail');
  await anchor.scrollIntoViewIfNeeded(); await anchor.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const layout = await component().evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, text: element.innerText }));
  assert(layout.clientWidth > 0 && layout.documentWidth <= width + 1 && layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  layouts.push({ name, width, height, theme, ...layout }); captures.push(name + '.png'); await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false }); save(name + '-dom.txt', layout.text);
}
function assertProof(proof, original, raw) {
  const decision = validateDefectTicketDecision(JSON.parse(raw)); assert.deepEqual(Buffer.from(canonical(decision) + '\n'), raw);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'manual-defect-ticket-action');
  for (const key of ['projectId', 'ticketId', 'actionId', 'requestFingerprint']) assert.equal(proof[key], original[key]);
  if (proof.outcome === 'rejected') { assert.deepEqual(proof.rejection, decision); assert.deepEqual(proof.rejection.original, original); assert.equal(proof.rejectionSha256, hash(raw)); }
  else {
    assert.equal(proof.outcome, 'recorded'); assert.deepEqual(proof.event, decision); assert.equal(proof.eventSha256, hash(raw)); assert.equal(decision.kind, original.kind);
    const request = decision.kind === 'create' ? { ticketId: decision.ticketId, actionId: decision.actionId, sourceOperationId: decision.source.operationId,
      memberCheckIds: decision.members.map(value => value.checkId), title: decision.title, severity: decision.severity, description: decision.description, reproduction: decision.reproduction }
      : { actionId: decision.actionId, afterOperationId: decision.after.operationId, expectedRevision: decision.revision - 1,
        expectedHeadSha256: decision.previousEventSha256, memberSetDigest: decision.memberSetDigest, factsDigest: decision.factsDigest,
        previewDigest: decision.previewDigest, resolution: decision.resolution, confirmed: decision.confirmed };
    assert.deepEqual(request, original.request);
  }
  return decision;
}
async function runCase({ caseId, kind, intendedWinner, ticketId }) {
  const item = { caseId, kind, intendedWinner, completed: false, checks: {} }; cases.push(item);
  const folder = 'case-' + caseId; fs.mkdirSync(join(OUT, folder)); const write = (name, value) => save(folder + '/' + name, value);
  const path = fullTicketPath() + (kind === 'close' ? '/' + ticketId + '/close' : ''), state = relay.arm({ caseId, path, intendedWinner });
  const originalsBefore = originals(), targetBefore = targetRequests.length, decisionsBefore = tree(join(ROOT, 'defect-tickets'));
  const ticketBefore = kind === 'close' ? await ticketSnapshot(ticketId) : null, draftBefore = await draftSnapshot(), postCount = uiPosts().length;
  write('baseline.json', { originals: originalsBefore, targetCount: targetBefore, decisions: decisionsBefore, ticket: ticketBefore, draft: draftBefore });
  const submit = component().getByTestId(kind === 'create' ? 'defect-ticket-create' : 'defect-ticket-close');
  await waitFor(async () => !(await submit.isDisabled()), 'explicit original ready'); await submit.click();
  await bounded(state.originalReady.promise, caseId + ' original prefix ready');
  const browserOriginal = await waitFor(() => uiPosts().find(value => value.body?.actionId === state.actionId && value.path === path), 'original UI raw bytes recorded');
  assert.equal(state.originalFrontCount, 1); assert.equal(state.originalForwardCount, 1);
  const originalRelay = state.events.find(value => value.event === 'original-body');
  assert.equal(originalRelay.host, new URL(uiBase).host); assert.equal(originalRelay.origin, uiBase);
  assert.deepEqual(Buffer.from(browserOriginal.rawBody), state.rawOriginal); assert.equal(browserOriginal.bodySha256, state.slow.bodySha256);
  const originalStorage = await storage(); assert.equal(originalStorage.values.length, 1); const original = originalStorage.values[0];
  assert.deepEqual(original.request, browserOriginal.body); assert.equal(original.actionId, state.actionId); assert.equal(original.kind, kind);
  assert.equal(original.projectId, project.id); assert.equal(original.version, 1); if (ticketId) assert.equal(original.ticketId, ticketId);
  assert.equal(original.requestFingerprint, hash(Buffer.from(canonical({ domain: 'heimdall-defect-ticket-request', version: 1,
    projectId: original.projectId, ticketId: original.ticketId, kind, request: original.request }))));
  item.actionId = original.actionId; item.ticketId = original.ticketId; item.requestFingerprint = original.requestFingerprint;
  write('original-confirmation.json', original); write('original-storage-before.json', originalStorage); write('original-ui-body.raw.json', state.rawOriginal);
  write('original-ui-request.json', browserOriginal); item.checks.uiOriginalBound = true;
  const ingress = () => lines(ingressLog).filter(value => value.traceId === state.traceId);
  await waitFor(() => { const values = ingress(); return values.some(value => value.event === 'data' && value.bytes === state.slow.splitAt) && values; }, 'engine actually received exact original prefix', 25000);
  const prefix = ingress(), request = prefix.filter(value => value.event === 'request'); assert.equal(request.length, 1); assert.equal(request[0].contentLength, state.rawOriginal.length);
  assert.equal(new Set(prefix.map(value => value.connectionId)).size, 1); assert.equal(new Set(prefix.map(value => value.requestId)).size, 1);
  assert.equal(prefix.at(-1).bytes, state.slow.splitAt); assert.equal(prefix.at(-1).bodySha256, hash(state.rawOriginal.subarray(0, state.slow.splitAt)));
  assert.equal(prefix.some(value => ['end', 'aborted', 'close'].includes(value.event)), false); write('ingress-prefix.json', prefix); item.checks.prefixObservedBeforeDownstream502 = true;
  state.sendControlled502(); await waitFor(() => browserOriginal.finished, 'controlled HTTP response finishes normally');
  assert.equal(browserOriginal.failed, null); const browserControlled = browserResponses.find(value => value.requestId === browserOriginal.id && value.status === 502); assert(browserControlled);
  const observedControlledBytes = await transportResponses.get(browserOriginal.id).body(); assert.deepEqual(observedControlledBytes, state.controlledRawReply);
  browserControlled.rawBody = observedControlledBytes.toString('utf8'); browserControlled.bodySha256 = hash(observedControlledBytes); browserControlled.payload = JSON.parse(observedControlledBytes);
  write('controlled-http-502.raw.json', observedControlledBytes); item.checks.controlled502FinishedNormally = true;
  await waitFor(async () => await component().getByTestId('defect-ticket-error').isVisible() && await component().getAttribute('aria-busy') === 'false', 'unknown response settled');
  assert.deepEqual(await storage(), originalStorage); const pending = component().locator('[data-defect-action="' + original.actionId + '"]');
  assert.equal(await pending.count(), 1); assert.equal(await component().getByTestId('defect-ticket-create').isDisabled(), true);
  assert.deepEqual(await draftSnapshot(), draftBefore); item.checks.unknownRetainsFullOriginal = true;
  if (caseId === 'A') await capture('A-create-unknown-desktop-light', 1440, 1000, 'light', true);
  if (caseId === 'C') await capture('C-close-unknown-mobile-dark', 390, 844, 'dark', true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const actionUrl = uiBase + fullTicketPath() + '/actions/' + original.actionId;
  const actionGets = () => browserRequests.filter(value => value.url === actionUrl && value.method === 'GET');
  const relayBeforeRead = relay.replies.length;
  const readOnly = page.waitForResponse(value => value.url() === actionUrl && value.request().method() === 'GET');
  await pending.getByTestId('defect-ticket-reconcile').click(); const unresolved = await actionResponsePayload(await readOnly, relayBeforeRead);
  assert.equal(unresolved.outcome, 'unresolved'); assert.equal(unresolved.reason, 'ABSENCE_IS_NOT_A_COMMIT_DECISION');
  await waitFor(async () => await component().getAttribute('aria-busy') === 'false', 'read-only unresolved settled');
  assert.deepEqual(await storage(), originalStorage); assert.equal(uiPosts().length, postCount + 1); write('read-only-unresolved.json', unresolved); item.checks.readOnlyUnresolvedPreservesOriginal = true;
  // 点击前的 GET 计数：零增量才是"点击被丢弃"，否则是请求已发出但响应/响应体丢失。
  // 必须在这里就绑定一个短超时等待，否则脚本只会挂在 60s 的 actionResponsePayload 上，
  // 让两种完全不同的故障表现成同一个超时。
  const getsBeforeDeny = actionGets().length;
  const relayBeforeDenyPreflight = relay.replies.length;
  const preflight = page.waitForResponse(value => value.url() === actionUrl && value.request().method() === 'GET');
  await pending.getByTestId('defect-ticket-deny-confirm').check(); await pending.getByTestId('defect-ticket-deny').click();
  await waitFor(() => actionGets().length > getsBeforeDeny || browserRequests.some(value => value.path === fullTicketPath() + '/actions/' + original.actionId + '/deny'),
    caseId + ' deny click issued an action request (zero means the UI dropped the click; state was ' + JSON.stringify({
      pending: await pending.count(), checked: await pending.getByTestId('defect-ticket-deny-confirm').isChecked(),
      denyEnabled: !(await pending.getByTestId('defect-ticket-deny').isDisabled()) }), 15000);
  const preflightPayload = await actionResponsePayload(await preflight, relayBeforeDenyPreflight); assert.equal(preflightPayload.outcome, 'unresolved'); write('deny-preflight-unresolved.json', preflightPayload);
  await bounded(state.denyReady.promise, caseId + ' exact UI deny body received');
  const denyBody = JSON.parse(state.rawDeny); assert.deepEqual(denyBody, { schemaVersion: 1, confirmed: true, original });
  const browserDeny = uiPosts().filter(value => value.path === fullTicketPath() + '/actions/' + original.actionId + '/deny');
  assert.equal(browserDeny.length, 1); assert.deepEqual(Buffer.from(browserDeny[0].rawBody), state.rawDeny);
  write('deny-ui-body.raw.json', state.rawDeny); item.checks.manualDenyBoundExact = true;
  let originalReply, denyReply, diskAtWinner;
  const decisionPath = join(ROOT, 'defect-tickets/v1/events', original.actionId + '.json');
  if (intendedWinner === 'rejected') {
    denyReply = await bounded(state.denyReply.promise, caseId + ' real deny ack'); assert.equal(denyReply.status, 201); assert.equal(denyReply.payload.outcome, 'rejected');
    const atDeny = ingress(); assert.equal(atDeny.some(value => ['end', 'aborted', 'close'].includes(value.event)), false);
    assert.equal(atDeny.at(-1).bytes, state.slow.splitAt); write('ingress-at-deny-ack.json', atDeny);
    diskAtWinner = fs.readFileSync(decisionPath); assertProof(denyReply.payload, original, diskAtWinner);
    await waitFor(async () => await pending.count() === 0 && await component().getAttribute('aria-busy') === 'false', 'rejected proof releases exact pending before original tail');
    const releasedBeforeTail = await storage(); assert.deepEqual(releasedBeforeTail.values, []); write('released-before-original-tail.json', releasedBeforeTail);
    state.finishOriginal(); originalReply = await bounded(state.slow.response, caseId + ' late original ack');
    assert.equal(originalReply.status, 200); assert.equal(originalReply.payload.outcome, 'rejected');
  } else {
    assert.equal(state.denyForwardCount, 0); assert.deepEqual(await storage(), originalStorage);
    write('ingress-at-held-deny.json', ingress()); state.finishOriginal(); originalReply = await bounded(state.slow.response, caseId + ' original accepted ack');
    assert.equal(originalReply.status, 201); assert.equal(originalReply.payload.outcome, 'recorded');
    diskAtWinner = fs.readFileSync(decisionPath); assertProof(originalReply.payload, original, diskAtWinner);
    write('accepted-before-deny-forward.json', { status: originalReply.status, payload: originalReply.payload, diskSha256: hash(diskAtWinner), denyForwardCount: state.denyForwardCount });
    state.forwardDeny(); denyReply = await bounded(state.denyReply.promise, caseId + ' original accepted proof through deny');
    assert.equal(denyReply.status, 200); assert.equal(denyReply.payload.outcome, 'recorded');
  }
  item.checks.winnerOrderingProved = true; item.actualOutcome = denyReply.payload.outcome; assert.equal(item.actualOutcome, intendedWinner);
  assertProof(denyReply.payload, original, diskAtWinner); assertProof(originalReply.payload, original, diskAtWinner);
  assert.deepEqual(fs.readFileSync(decisionPath), diskAtWinner); write('decision.raw.json', diskAtWinner);
  write('original-upstream-response.raw.json', originalReply.bytes); write('deny-response.raw.json', denyReply.bytes);
  const browserDenyResponse = await waitFor(() => browserResponses.find(value => value.requestId === browserDeny[0].id
    && value.method === 'POST' && value.status === denyReply.status), caseId + ' deny browser response recorded');
  const relayedDenyResponse = await waitFor(() => relay.replies.find(value => value.method === 'POST'
    && new URL(value.path, 'http://relay.invalid').pathname === browserDeny[0].path
    && value.status === denyReply.status && value.rawBody?.equals?.(denyReply.bytes)), caseId + ' deny relay body available');
  assert.deepEqual(await reconcileActionResponseBody(browserDenyResponse, relayedDenyResponse), denyReply.payload);
  write('reply-statuses.json', { original: originalReply.status, deny: denyReply.status }); item.checks.completeProofMatchesDisk = true; item.checks.lateOriginalMatchesWinningDecision = true;
  await waitFor(() => ingress().some(value => value.event === 'end'), 'unique complete ingress body'); const completeIngress = ingress();
  assert.equal(completeIngress.filter(value => value.event === 'request').length, 1); assert.equal(completeIngress.filter(value => value.event === 'end').length, 1);
  assert.equal(completeIngress.filter(value => value.event === 'aborted').length, 0); assert.equal(new Set(completeIngress.map(value => value.connectionId)).size, 1);
  assert.equal(new Set(completeIngress.map(value => value.requestId)).size, 1); const end = completeIngress.find(value => value.event === 'end');
  assert.equal(end.bytes, state.rawOriginal.length); assert.equal(end.bodySha256, browserOriginal.bodySha256); write('ingress-complete.json', completeIngress);
  assert(state.slow.events.filter(value => value.event === 'connected').length <= 1); assert.equal(state.slow.events.filter(value => value.event === 'tail-released').length, 1);
  assert.equal(state.originalForwardCount, 1); item.checks.oneUpstreamRequestAndBodyEnd = true;
  assert.equal(state.denyFrontCount, 1); assert.equal(state.denyForwardCount, 1); assert.equal(uiPosts().length, postCount + 2); item.checks.oneDenyRequestAndOneForward = true;
  await waitFor(async () => await pending.count() === 0 && await component().getAttribute('aria-busy') === 'false', 'pending is released only after complete proof');
  const afterStorage = await storage(); assert.deepEqual(afterStorage.values, []); write('original-storage-after.json', afterStorage); item.checks.pendingReleasedAfterProof = true;
  const notice = await component().getByTestId('defect-ticket-notice').innerText(); assert.deepEqual(await draftSnapshot(), draftBefore);
  if (intendedWinner === 'rejected') {
    assert(notice.includes('原动作已永久拒绝')); assert(!notice.includes('已明确关闭固定关联检查')); assert(!notice.includes('人工缺陷单已记录'));
    if (kind === 'create') assert.equal((await component().getByTestId('defect-ticket-detail').innerText()).includes(original.ticketId), false);
  } else {
    assert(notice.includes('原动作已记录')); await waitFor(async () => (await component().getByTestId('defect-ticket-detail').innerText()).includes(original.ticketId), 'recorded opens real ticket');
  }
  write('ui-outcome.json', { notice, draftAfter: await draftSnapshot(), text: await component().innerText() }); item.checks.uiOutcomeAndDraft = true;
  const afterTicket = await ticketSnapshot(original.ticketId, !(kind === 'create' && intendedWinner === 'rejected'));
  if (intendedWinner === 'rejected' && kind === 'close') assert.deepEqual(afterTicket, ticketBefore);
  if (intendedWinner === 'recorded') {
    assert.equal(afterTicket.ticket.revision, kind === 'create' ? 0 : 1); assert.equal(afterTicket.ticket.processingStatus, kind === 'create' ? 'open' : 'closed');
    assert.equal(afterTicket.ticket.history.length, kind === 'create' ? 1 : 2);
    if (kind === 'close') { assert.equal(afterTicket.ticket.verificationStatus, 'verified_passed'); assert.equal(afterTicket.ticket.counts.passed, 2); }
  }
  write('ticket-after.json', afterTicket); item.checks.ticketEffectMatchesWinner = true;
  const afterOriginals = originals(); assert.deepEqual(afterOriginals, originalsBefore); assert.equal(targetRequests.length, targetBefore); item.checks.sideEffectsUnchanged = true;
  const decisionsAfter = tree(join(ROOT, 'defect-tickets')), newName = 'v1/events/' + original.actionId + '.json';
  assert.deepEqual(decisionsAfter, { ...decisionsBefore, [newName]: { bytes: diskAtWinner.length, sha256: hash(diskAtWinner) } }); item.checks.decisionTreeOnlyExpectedAddition = true;
  const get = await api(ticketPath() + '/actions/' + original.actionId); assertProof(get, original, diskAtWinner); assert.equal(get.outcome, intendedWinner); write('action-get.json', get); item.checks.postGetMatchesWinner = true;
  write('side-effects-after.json', { originals: afterOriginals, targetCount: targetRequests.length, decisions: decisionsAfter });
  write('relay-events.json', state.events); write('original-stream-events.json', state.slow.events);
  for (const name of caseCheckNames) assert.equal(item.checks[name], true, caseId + '.' + name);
  item.rawBodySha256 = hash(state.rawOriginal); item.decisionSha256 = hash(diskAtWinner); item.completed = true; state.completed = true; write('case.json', item);
  return original;
}

console.log(JSON.stringify({ event: 'started', startedAt, outputDirectory: OUT, kind: 'manual-defect-ticket-decision-browser-smoke' }));
try {
  assert(fs.existsSync(resolve(CORE, '../console/dist/index.html')), 'Build console first.');
  implementationInputs = inputSnapshot(); save('implementation-inputs-before.json', implementationInputs);
  const owner = acquireAcceptanceOwner({ root: ROOT }); try { await createAcceptanceCatalogStore({ root: ROOT, owner }).initialize({ createSchemaVersion: 4 }); } finally { owner.release(); }
  target = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname; targetRequests.push({ method: request.method, path, at: new Date().toISOString() });
    const missing = path.startsWith('/source') && !sourceAvailable; response.writeHead(missing ? 410 : 200, { 'content-type': 'text/html' });
    response.end(missing ? 'Source intentionally unavailable after capture' : html({ broken: path.startsWith('/broken') }));
  });
  targetBase = await listen(target); save('controlled-source.html', html()); save('controlled-bug.html', html({ broken: true })); await startEngine();
  const plan = { name: 'D6 fixed manual decisions', mode: 'regression', baselineUrl: targetBase + '/source?token=d6-source-url-sentinel', targetUrl: targetBase + '/broken', routes: ['/'],
    viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }], timeoutMs: 4000, settleMs: 50,
    points: [{ id: 'menu', title: 'Expanded menu', route: '/', severity: 'high', steps: [{ action: 'fill', selector: '#entry', value: 'd6-fill-sentinel' }, { action: 'click', selector: '#menu-toggle' }],
      assertions: [{ kind: 'visible', selector: '#menu' }, { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }, { kind: 'text', selector: '#literal', equals: 'd6-captured-source-sentinel' }] }] };
  source = await api('runs', plan, 202); await waitFor(async () => (await api('runs/' + source.runId)).status === 'completed', 'fresh source captured', 90000);
  const sourceReport = await api('runs/' + source.runId + '/report'); assert.equal(sourceReport.gate, 'failed'); assert.equal(sourceReport.checks.length, 14); check('realCapturedSource');
  project = (await api('projects', { ...cas(await latest()), name: 'D6 fixed manual defect decisions' }, 201)).project;
  const release = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: 'Approved captured source', targetUrl: plan.baselineUrl }, 201)).release;
  const binding = (await api('projects/' + project.id + '/browser-source-bindings', { ...cas(await latest()), releaseId: release.id, runId: source.runId, sourceSide: 'baseline' }, 201)).binding;
  const review = await api('projects/' + project.id + '/browser-source-bindings/' + binding.id + '/candidate-preview');
  candidate = (await api('projects/' + project.id + '/browser-baseline-candidates', { ...cas(await latest()), sourceBindingId: binding.id, contentDigest: review.contentDigest }, 201)).candidate;
  const releases = {}; for (const path of ['broken', 'healthy']) releases[path] = (await api('projects/' + project.id + '/releases', { ...cas(await latest()), label: path, targetUrl: targetBase + '/' + path }, 201)).release;
  sourceBytes = tree(join(ROOT, source.runId)); sourceRequestsBeforeUnavailable = targetRequests.filter(value => value.path.startsWith('/source')).length; sourceAvailable = false;
  bad = await operation(releases.broken); const badChecks = bad.report.report.checks;
  selected = [badChecks.find(value => value.identity.facet === 'visual' && value.viewport === 'desktop' && value.verdict === 'bug'),
    badChecks.find(value => value.identity.facet === 'behavior' && value.viewport === 'desktop' && value.verdict === 'bug')];
  assert(selected.every(Boolean)); assert.equal(new Set(selected.map(value => value.id)).size, 2); check('registeredTwoFixedFailures');
  await startBrowser(); await openConsole(); assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await component().getByTestId('defect-tickets-candidate').selectOption(candidate.id); await component().getByTestId('defect-tickets-source').selectOption(bad.input.operationId);
  for (const value of selected) await component().locator('[data-testid="defect-ticket-member"][data-check-id="' + value.id + '"]').check();
  await component().getByTestId('defect-ticket-title').fill('菜单布局与展开行为的两个固定检查'); await component().getByTestId('defect-ticket-description').fill('本机受控样例：固定来源、两项可靠失败、人工动作决定。');
  await component().getByTestId('defect-ticket-reproduction').fill('打开页面，展开菜单，核对布局及导航。'); await component().getByTestId('defect-ticket-severity').selectOption('high');
  await component().getByTestId('defect-ticket-create-confirm').check(); const A = await runCase({ caseId: 'A', kind: 'create', intendedWinner: 'rejected' });
  await component().getByTestId('defect-ticket-create-confirm').check(); const B = await runCase({ caseId: 'B', kind: 'create', intendedWinner: 'recorded' });
  assert.notEqual(A.actionId, B.actionId); assert.notEqual(A.ticketId, B.ticketId); await capture('B-recorded-create-mobile-light', 390, 844, 'light'); await page.setViewportSize({ width: 1440, height: 1000 });
  healthy = await operation(releases.healthy, bad.input.operationId); await refreshTicket(B.ticketId); await previewClose(healthy.input.operationId);
  const preview = (await api(ticketPath() + '/' + B.ticketId + '/close-preview?afterOperationId=' + healthy.input.operationId)).preview;
  assert.equal(preview.closeEligible, true); assert.equal(preview.counts.passed, 2); assert.equal(preview.results.length, 2); check('registeredHealthyTwoMembers');
  await component().getByTestId('defect-ticket-resolution').fill('两项固定检查在同一次健康目标复验中通过。'); await component().getByTestId('defect-ticket-confirm').check();
  const C = await runCase({ caseId: 'C', kind: 'close', intendedWinner: 'rejected', ticketId: B.ticketId });
  await previewClose(healthy.input.operationId); await component().getByTestId('defect-ticket-confirm').check(); const D = await runCase({ caseId: 'D', kind: 'close', intendedWinner: 'recorded', ticketId: B.ticketId });
  assert.notEqual(C.actionId, D.actionId); await capture('D-recorded-close-desktop-dark', 1440, 1000, 'dark');
  assert.equal(new Set(cases.map(value => value.actionId)).size, 4); check('fourUniqueOriginalActions');
  assert(browserRequests.every(value => value.origin === uiBase)); assert.equal((await storage()).key, `heimdall:defect-tickets:v1:${uiBase}:${project.id}`); check('realUIOriginsAndReceiptScope');
  assert(cases.every(value => value.checks.oneUpstreamRequestAndBodyEnd)); check('sameUniqueUpstreamBodyPerCase');
  assert(cases.every(value => value.checks.completeProofMatchesDisk && value.checks.decisionTreeOnlyExpectedAddition)); check('denyAndAcceptedMutuallyExclusive');
  assert(cases.every(value => value.checks.sideEffectsUnchanged)); assert.equal(lines(relayLog).filter(value => ['fixture-error', 'proxy-error'].includes(value.event)).length, 0); check('noTargetOrSourceOrBrowserOrCatalogSideEffects');
  assert.deepEqual(tree(join(ROOT, source.runId)), sourceBytes); assert.equal(targetRequests.filter(value => value.path.startsWith('/source')).length, sourceRequestsBeforeUnavailable); check('sourceOriginalBytesRemain');
  assert.equal(captures.length, 4); assert.equal(layouts.length, 4); assert.equal(layouts.filter(value => value.width < 500).length, 2); check('pendingLayoutsDesktopMobile');
  await Promise.all([...responseReads]); const controlled = relay.cases.map(value => value.controlledReply); assert.equal(controlled.length, 4);
  for (const message of consoleMessages) {
    const url = new URL(message.location.url); assert.equal(url.origin, uiBase); assert.equal(message.type, 'error');
    assert.equal(message.text, 'Failed to load resource: the server responded with a status of 502 (Bad Gateway)');
    assert(controlled.some(value => value.caseId === message.caseId && value.status === 502 && value.path === url.pathname && !url.search && !url.hash), JSON.stringify(message));
  }
  const unreconciledReadFailures = browserResponses.filter(value => value.readFailure);
  assert.equal(unreconciledReadFailures.length, 0, JSON.stringify(unreconciledReadFailures));
  assert.equal(pageErrors.length, 0); assert.equal(await page.locator('vite-error-overlay').count(), 0); check('onlyExactControlledHttp502Errors');
  const inputsAfter = inputSnapshot(); save('implementation-inputs-after.json', inputsAfter); assert.deepEqual(inputsAfter, implementationInputs); check('implementationInputsUnchanged');
  assert.deepEqual(cases.map(value => [value.caseId, value.kind, value.actualOutcome, value.completed]), [['A', 'create', 'rejected', true], ['B', 'create', 'recorded', true], ['C', 'close', 'rejected', true], ['D', 'close', 'recorded', true]]); check('fourCompleteCases');
  save('final-ticket.json', await api(ticketPath() + '/' + B.ticketId)); save('source-file-digests.json', sourceBytes);
} catch (cause) {
  failure = cause; save('failure.json', { name: cause.name, message: cause.message, stack: cause.stack });
  if (page) { await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {}); save('failure-dom.txt', await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  await browser?.close().catch(() => {}); await stop(chromiumProcess);
  try { await relay?.drain(); }
  catch (cause) { failure ??= cause; save('teardown-failure.json', { name: cause.name, message: cause.message, stack: cause.stack }); }
  relay?.abort(); await stop(engine); await close(relay?.server); await close(target);
  const proxyFailures = relay ? lines(relayLog).filter(value => ['fixture-error', 'proxy-error', 'original-upstream-error'].includes(value.event)) : [];
  if (proxyFailures.length) failure ??= Error('The complete relay log contains unexpected errors, including during teardown.');
  save('engine.log', engineLog); save('chromium.log', chromiumLog); save('browser-requests.json', browserRequests); save('browser-responses.json', browserResponses);
  save('cdp-network.json', cdpNetwork); save('playwright-completions.json', playwrightCompletions);
  save('relay-state-events.json', relay?.cases.map(value => ({ caseId: value.caseId, actionId: value.actionId, events: value.events })) ?? []);
  save('target-requests.json', targetRequests); save('browser-errors.json', { pageErrors, consoleMessages, controlledReplies: relay?.cases.map(value => value.controlledReply).filter(Boolean) ?? [] });
  save('checks.json', checks); save('layouts.json', layouts);
  const passed = !failure && cases.length === 4 && cases.every(value => value.completed && caseCheckNames.every(name => value.checks[name] === true))
    && requiredChecks.every(name => checks[name] === true) && Object.keys(checks).length === requiredChecks.length;
  const summary = { schemaVersion: 1, kind: 'manual-defect-ticket-decision-browser-smoke', startedAt, endedAt: new Date().toISOString(), passed,
    caseCount: cases.length, cases, requiredChecks, caseCheckNames, checkCount: Object.keys(checks).length, checks, captures,
    outputDirectory: OUT, engineBase, uiBase, targetBase, evidenceLevel: 'real-local-chromium-ui-original-body-single-upstream-prefix-controlled-http-502-manual-decision',
    guaranteeScope: 'Same real data root and retained immutable action ledger; controlled sample; no power-loss or rollback guarantee.',
    sourceRunId: source?.runId, badOperationId: bad?.input.operationId, healthyOperationId: healthy?.input.operationId,
    pageErrors, ...(failure ? { failure: { message: failure.message } } : {}) };
  save('summary.json', summary); console.log(JSON.stringify(summary)); if (!passed) process.exitCode = 1;
}
