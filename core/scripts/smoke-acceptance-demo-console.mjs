#!/usr/bin/env node
/** D7 fresh launcher -> native UI capture, fixed executions and manual closure.
 * Browser plugin not available; use the repository Playwright/CDP path.
 * No request interception, fabricated GETs, injected failures or prepared results.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startAcceptanceDemo } from './start-acceptance-demo.mjs';
import { DEFAULT_VIEWPORTS } from '../src/acceptance/schema.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const REPO = resolve(CORE, '..');
const SCRIPT = fileURLToPath(import.meta.url);
const PROJECT_NAME = '本地固定演示 · 还原度与缺陷复验';
const SOURCE_NAME = '本地固定示例 · 参考与已知缺陷';
const TICKET_TITLE = '本地演示 · 桌面布局与菜单展开';
const RESOLUTION = '同一固定候选的桌面视觉与菜单行为已在完全修复版本同次通过；明确关闭这两项固定检查。';
const RAW_BLOCKS = ['organizationContext', 'sourceProjection', 'scope', 'rules', 'selectedOracles',
  'selectedEvidence', 'verifiedEvidence', 'environment', 'urlProof', 'limitations'];
const INPUTS = [
  'core/scripts/smoke-acceptance-demo-console.mjs', 'core/scripts/start-acceptance-demo.mjs',
  'core/src/acceptance/demo-pages.mjs', 'core/src/engine-server.mjs',
  'core/src/acceptance/schema.mjs', 'core/src/acceptance/runner.mjs',
  'core/src/acceptance/browser-candidate-projection.mjs', 'core/src/acceptance/browser-candidate-review.mjs',
  'core/src/acceptance/browser-operation-store.mjs', 'core/src/acceptance/browser-operation-schema.mjs',
  'core/src/acceptance/defect-ticket-api.mjs', 'core/src/acceptance/defect-ticket-service.mjs',
  'core/src/acceptance/defect-ticket-source.mjs', 'core/src/acceptance/defect-ticket-store.mjs',
  'core/src/acceptance/defect-ticket-schema.mjs', 'core/src/acceptance/defect-ticket-model.mjs',
  'core/src/acceptance/defect-ticket-report.mjs', 'console/src/acceptance-demo.js',
  'console/src/AcceptanceWorkbench.vue', 'console/src/acceptance-workbench.js',
  'console/src/AcceptanceCatalog.vue', 'console/src/acceptance-catalog.js',
  'console/src/AcceptanceBrowserBindings.vue', 'console/src/acceptance-browser-bindings.js',
  'console/src/AcceptanceBrowserCandidates.vue', 'console/src/acceptance-browser-candidates.js',
  'console/src/AcceptanceBrowserExecution.vue', 'console/src/acceptance-browser-execution.js',
  'console/src/AcceptanceDefectTickets.vue', 'console/src/acceptance-defect-tickets.js',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const errorOf = error => ({ name: error?.name, message: error?.message, code: error?.code, stack: error?.stack,
  ...(error?.cause ? { cause: { name: error.cause.name, message: error.cause.message, code: error.cause.code } } : {}) });

function fileFact(path) {
  const stat = fs.lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, 'No linked evidence: ' + path);
  assert.equal(stat.isFile(), true, 'Ordinary evidence required: ' + path);
  const bytes = fs.readFileSync(path);
  return { bytes: bytes.length, sha256: hash(bytes) };
}
function tree(root, excluded = new Set(), prefix = '') {
  const output = {};
  if (!fs.existsSync(root)) return output;
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false, 'No linked evidence tree.');
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (excluded.has(name)) continue;
    const path = join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'No linked evidence: ' + path);
    if (entry.isDirectory()) for (const [child, fact] of Object.entries(tree(path, excluded, name))) output[entry.name + '/' + child] = fact;
    else output[entry.name] = fileFact(path);
  }
  return output;
}
function currentInputs() {
  return { sources: Object.fromEntries(INPUTS.map(path => [path, fileFact(join(REPO, path))])),
    consoleBundle: tree(join(REPO, 'console/dist')) };
}
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }

export async function runAcceptanceDemoConsoleSmoke({ outDir } = {}) {
  const OUT = resolve(outDir ?? join(CORE, 'workspace/_runs/acceptance-demo-console-' + randomUUID()));
  assert.equal(fs.existsSync(OUT), false, 'Use a fresh evidence directory; original evidence is never overwritten.');
  fs.mkdirSync(resolve(OUT, '..'), { recursive: true }); fs.mkdirSync(OUT);
  for (const name of ['network', 'actions', 'readbacks', 'screenshots', 'downloads']) fs.mkdirSync(join(OUT, name));
  const startedAt = new Date().toISOString(), timeline = [], checks = {}, browserRequests = [], responses = [],
    requestFailures = [], captureFailures = [], pageErrors = [], consoleMessages = [], layouts = [], actions = [],
    confirmations = [], pending = new Set(), requestMap = new WeakMap(), cleanupErrors = [];
  let stage = 'prepare', demo, browser, context, page, chromiumProcess, failure, source, sourceReport,
    sourceBefore, sourceAfter, candidate, fullReview, plan, totalChecks, desktop, ticketId, closedTicket,
    fixedReadOnlyBefore, fixedReadOnlyAfter, inputBefore, inputAfter, downloadFact, demoTerminal, root, base;
  const operations = [], sourceSnapshots = [];
  const save = (path, value) => {
    const target = join(OUT, path);
    fs.writeFileSync(target, Buffer.isBuffer(value) || typeof value === 'string' ? value : json(value), { flag: 'wx' });
    return { path: path.replaceAll('\\', '/'), ...fileFact(target) };
  };
  const event = (kind, detail = {}) => {
    const entry = { sequence: timeline.length + 1, at: new Date().toISOString(), stage, kind, ...detail };
    timeline.push(entry); fs.appendFileSync(join(OUT, 'events.jsonl'), JSON.stringify(entry) + '\n');
    console.log(JSON.stringify(entry)); return entry;
  };
  const check = (name, detail = {}) => {
    checks[name] = { passed: true, at: new Date().toISOString(), ...detail };
    fs.writeFileSync(join(OUT, 'progress.json'), json({ stage, checks })); event('check', { name, ...detail });
  };
  const track = task => {
    const safe = task.catch(error => { captureFailures.push({ at: new Date().toISOString(), stage, error: errorOf(error) }); });
    pending.add(safe); safe.finally(() => pending.delete(safe)); return safe;
  };
  const flush = async () => { while (pending.size) await Promise.all([...pending]); };
  async function waitFor(fn, label, budget = 120000) {
    const deadline = Date.now() + budget; let last;
    while (Date.now() < deadline) {
      try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
      await delay(125);
    }
    throw new Error(label + ': ' + (last?.message ?? 'state not reached'), { cause: last });
  }
  const workbench = () => page.getByTestId('acceptance-workbench');
  const catalog = () => page.getByTestId('acceptance-catalog');
  const execution = () => page.getByTestId('browser-execution');
  const tickets = () => page.getByTestId('defect-tickets');
  const projectPath = () => '/api/acceptance/projects/' + demo.session.metadata.project.id;
  const executionPath = () => projectPath() + '/browser-executions';
  const ticketPath = () => projectPath() + '/defect-tickets';
  const posts = () => browserRequests.filter(request => request.method === 'POST');
  const targetRequests = () => {
    const raw = fs.readFileSync(join(demo.sessionDir, 'target-requests.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const referenceRequests = () => targetRequests().filter(request => request.path === '/reference');
  async function selectVisible(locator, matches, label) {
    await locator.waitFor({ state: 'visible' });
    const choices = await waitFor(async () => {
      const options = await locator.locator('option').evaluateAll(items => items.map(item => ({ label: item.label, disabled: item.disabled })));
      const selected = options.filter(option => !option.disabled && (typeof matches === 'string' ? option.label === matches : matches.test(option.label)));
      assert.ok(selected.length <= 1, 'Ambiguous visible choice for ' + label + ': ' + JSON.stringify(selected));
      return selected.length === 1 && selected;
    }, 'visible choice ' + label);
    await locator.selectOption({ label: choices[0].label });
    event('visible-select', { label, optionLabel: choices[0].label });
  }
  async function expand(locator) {
    await locator.waitFor({ state: 'visible' });
    if (await locator.getAttribute('open') === null) await locator.locator(':scope > summary').click();
  }
  async function capture(name, anchor, width = 1440, height = 1000) {
    await page.setViewportSize({ width, height });
    await anchor.scrollIntoViewIfNeeded();
    await anchor.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const layout = await anchor.evaluate(element => ({ documentWidth: document.documentElement.scrollWidth,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, rect: element.getBoundingClientRect().toJSON(),
      text: element.innerText }));
    const screenshotPath = 'screenshots/' + name + '.png';
    await page.screenshot({ path: join(OUT, screenshotPath), fullPage: false });
    save('screenshots/' + name + '-dom.txt', layout.text);
    const value = { name, width, height, screenshot: { path: screenshotPath, ...fileFact(join(OUT, screenshotPath)) }, ...layout };
    layouts.push(value); save('screenshots/' + name + '-layout.json', value);
    assert.ok(layout.clientWidth > 0 && layout.documentWidth <= width + 1
      && layout.scrollWidth <= layout.clientWidth + 1, 'Horizontal layout overflow: ' + JSON.stringify(value));
    return value;
  }
  async function capturePair(name, anchor) {
    await capture(name + '-desktop', anchor);
    await capture(name + '-mobile', anchor, 390, 844);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function responseValue(name, response, expectedStatus) {
    const bytes = Buffer.from(await response.body());
    const body = save('actions/' + name + '-response.bin', bytes);
    const value = JSON.parse(bytes.toString('utf8'));
    assert.equal(response.status(), expectedStatus, name + ': ' + bytes.toString('utf8'));
    return { response, value, raw: body };
  }
  async function uiWrite(name, path, click, expectedStatus) {
    const previous = posts().filter(request => request.path === path).length;
    const awaited = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path,
      { timeout: 120000 });
    const [response] = await Promise.all([awaited, click()]);
    const value = await responseValue(name, response, expectedStatus);
    const request = value.response.request(), raw = request.postDataBuffer() ?? Buffer.alloc(0);
    const requestBody = save('actions/' + name + '-request.bin', raw), body = JSON.parse(raw.toString('utf8'));
    assert.equal(posts().filter(item => item.path === path).length, previous + 1, name + ' must issue exactly one explicit POST');
    const action = { name, at: new Date().toISOString(), stage, method: 'POST', path, body, status: expectedStatus,
      requestRaw: requestBody, responseRaw: value.raw, payload: value.value };
    actions.push(action); save('actions/' + name + '.json', action); event('ui-write', { name, path, status: expectedStatus });
    return action;
  }
  async function uiRead(name, path, click) {
    const awaited = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === path,
      { timeout: 120000 });
    const [response] = await Promise.all([awaited, click()]);
    const value = await responseValue(name, response, 200);
    save('actions/' + name + '.json', { method: 'GET', path, raw: value.raw, payload: value.value }); return value.value;
  }
  async function readApi(name, path) {
    // Read-only verification is real HTTP. This helper cannot issue mutations.
    const started = new Date().toISOString();
    const response = await new Promise((ready, reject) => {
      const request = httpRequest(base + path, { method: 'GET', agent: false,
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) }, incoming => {
        const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.once('error', reject);
        incoming.once('aborted', () => reject(new Error('Readback response aborted')));
        incoming.once('end', () => ready({ status: incoming.statusCode, headers: incoming.headers, bytes: Buffer.concat(chunks) }));
      });
      request.once('error', reject); request.end();
    });
    const raw = save('readbacks/' + name + '-response.bin', response.bytes);
    const metadata = { name, path, method: 'GET', startedAt: started, endedAt: new Date().toISOString(),
      status: response.status, headers: response.headers, raw };
    save('readbacks/' + name + '.json', metadata);
    assert.equal(response.status, 200, 'Readback ' + path + ': ' + response.bytes.toString('utf8'));
    return JSON.parse(response.bytes.toString('utf8'));
  }
  async function startBrowser() {
    const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
    chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [stream, name] of [[chromiumProcess.stdout, 'chromium.stdout.log'], [chromiumProcess.stderr, 'chromium.stderr.log']])
      stream.on('data', bytes => fs.appendFileSync(join(OUT, name), bytes));
    chromiumProcess.on('error', error => event('chromium-process-error', { error: errorOf(error) }));
    const active = join(profile, 'DevToolsActivePort');
    await waitFor(() => {
      assert.equal(chromiumProcess.exitCode, null, 'Owned Chromium exited before CDP readiness');
      return fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0];
    }, 'owned CDP ready', 30000);
    const cdp = 'http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0];
    const version = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(10000) });
    save('cdp-version.json', await version.json()); browser = await chromium.connectOverCDP(cdp);
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
    page = await context.newPage(); page.setDefaultTimeout(90000);
    page.on('pageerror', error => { pageErrors.push({ at: new Date().toISOString(), stage, error: errorOf(error) }); });
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) consoleMessages.push({ at: new Date().toISOString(), stage,
        type: message.type(), text: message.text(), location: message.location() });
    });
    page.on('request', request => {
      const url = new URL(request.url()); if (url.origin !== base || !url.pathname.startsWith('/api/acceptance/')) return;
      const index = browserRequests.length + 1, prefix = 'network/' + String(index).padStart(5, '0');
      const body = request.postDataBuffer();
      const entry = { sequence: index, at: new Date().toISOString(), stage, method: request.method(), url: request.url(),
        path: url.pathname, query: url.search, headers: request.headers(), ...(body ? { raw: save(prefix + '-request.bin', body) } : {}) };
      if (body) { try { entry.body = JSON.parse(body.toString('utf8')); } catch { entry.bodyIsJson = false; } }
      browserRequests.push(entry); requestMap.set(request, { entry, prefix });
    });
    page.on('response', response => {
      const known = requestMap.get(response.request()); if (!known) return;
      track((async () => {
        const entry = { requestSequence: known.entry.sequence, at: new Date().toISOString(), stage,
          status: response.status(), headers: await response.allHeaders(), url: response.url() };
        try { entry.raw = save(known.prefix + '-response.bin', Buffer.from(await response.body())); }
        catch (error) {
          entry.bodyCaptureError = errorOf(error);
          captureFailures.push({ at: new Date().toISOString(), stage, requestSequence: known.entry.sequence,
            kind: 'response-body', error: entry.bodyCaptureError });
        }
        responses.push(entry); save(known.prefix + '.json', { request: known.entry, response: entry });
      })());
    });
    page.on('requestfailed', request => {
      const known = requestMap.get(request); if (known) requestFailures.push({ requestSequence: known.entry.sequence,
        at: new Date().toISOString(), stage, failure: request.failure() });
    });
  }
  async function confirm(name, checkbox) {
    assert.equal(await checkbox.isChecked(), false, name + ' requires a new explicit confirmation');
    assert.equal(await checkbox.isDisabled(), false, name + ' must be confirmable');
    await checkbox.check(); assert.equal(await checkbox.isChecked(), true);
    const value = { name, at: new Date().toISOString(), stage, checked: true };
    confirmations.push(value); event('explicit-confirmation', value);
  }
  async function openCompleteCandidate() {
    const bindingId = binding.binding.id;
    const bindingRow = page.locator('[data-testid="browser-binding-row"][data-binding-id="' + bindingId + '"]')
      .filter({ hasText: '参考来源 · baseline' });
    await bindingRow.waitFor({ state: 'visible' });
    assert.equal(await bindingRow.count(), 1);
    await waitFor(async () => !(await bindingRow.getByTestId('browser-binding-candidate-review').isDisabled()), 'saved binding candidate review ready');
    const value = await uiRead('candidate-full-preview', projectPath() + '/browser-source-bindings/' + bindingId + '/candidate-preview',
      () => bindingRow.getByTestId('browser-binding-candidate-review').click());
    const review = page.getByTestId('browser-candidate-review');
    await waitFor(async () => (await review.getByTestId('browser-candidate-diagnostics').innerText()).includes('完整合同已读取'), 'complete candidate contract rendered');
    await expand(review.getByTestId('browser-candidate-plan'));
    plan = JSON.parse(await review.getByTestId('browser-candidate-plan-json').innerText());
    assert.deepEqual(plan, value.review.sourcePlan); assert.deepEqual(plan.viewports, DEFAULT_VIEWPORTS);
    assert.equal(plan.baselineUrl, demo.session.fixtureOrigin + '/reference');
    assert.equal(plan.targetUrl, demo.session.fixtureOrigin + '/bug');
    assert.equal(plan.points.length, 1); assert.equal(plan.points[0].id, 'MENU-OPEN');
    assert.deepEqual(plan.routes, ['/']); desktop = plan.viewports.find(viewport => viewport.name === 'desktop'); assert.ok(desktop);
    for (const key of RAW_BLOCKS) {
      const block = review.getByTestId('browser-candidate-raw-' + key); await expand(block);
      const visible = JSON.parse(await review.getByTestId('browser-candidate-raw-' + key + '-json').innerText());
      assert.deepEqual(visible, ['organizationContext', 'sourceProjection'].includes(key) ? value[key] : value.review[key]);
      save('candidate-visible-' + key + '.json', visible);
    }
    totalChecks = value.review.scope.length;
    assert.ok(Number.isSafeInteger(totalChecks) && totalChecks > 0);
    assert.equal(value.review.declaredSlots, totalChecks); assert.equal(value.review.projectedSlots, totalChecks);
    assert.equal(sourceReport.coverage.planned, totalChecks); assert.equal(sourceReport.checks.length, totalChecks);
    assert.equal(sourceReport.coverage.completed, totalChecks); assert.equal(sourceReport.coverage.capped, false);
    assert.equal(value.sourceProjection.source.side, 'baseline'); assert.equal(value.review.sourceGate, 'failed');
    assert.equal(value.organizationContext.project.name, PROJECT_NAME); assert.equal(value.organizationContext.release.label, '参考来源');
    assert.equal(value.review.omissions.length, 0);
    const observations = review.getByTestId('browser-candidate-observation');
    assert.equal(await observations.count(), value.review.observations.length);
    for (let index = 0; index < value.review.observations.length; index++) {
      const observation = observations.nth(index); await expand(observation);
      assert.deepEqual(JSON.parse(await observation.getByTestId('browser-candidate-observation-json').innerText()), value.review.observations[index]);
    }
    const screenshotIndex = value.review.observations.findIndex(observation => observation.viewportName === 'desktop' && !observation.slot.pointId);
    assert.ok(screenshotIndex >= 0);
    const selected = observations.nth(screenshotIndex);
    for (const role of ['screenshot', 'repeat']) {
      await selected.getByTestId('browser-candidate-evidence-' + role).click();
      const image = selected.getByTestId('browser-candidate-evidence-image');
      await waitFor(() => image.evaluate((element, expectedRole) => element.dataset.role === expectedRole
        && element.complete && element.naturalWidth > 0, role), 'verified selected source ' + role);
      assert.ok((await selected.innerText()).includes('已核对大小与 SHA-256'));
      await capture('candidate-source-' + role, selected);
    }
    save('candidate-full-review.json', value); save('candidate-visible-plan.json', plan);
    await capturePair('candidate-complete-review', review);
    assert.equal(await review.getByTestId('browser-candidate-save').isDisabled(), true);
    await confirm('candidate-save', review.getByTestId('browser-candidate-confirm'));
    return value;
  }
  async function execute(label, stageName, beforeLabel, beforeId) {
    stage = 'execute-' + stageName; event('stage-start', { label });
    await selectVisible(execution().getByTestId('browser-execution-candidate'), /^参考来源 · /, 'saved reference candidate');
    await selectVisible(execution().getByTestId('browser-execution-target'), new RegExp('^' + label + ' · '), 'target ' + label);
    const review = await uiRead(stageName + '-execution-review', projectPath() + '/browser-baseline-candidates/' + candidate.id,
      () => execution().getByTestId('browser-execution-review').click());
    assert.equal(review.candidate.id, candidate.id); assert.equal(review.contentDigest, candidate.contentDigest);
    const approval = execution().getByTestId('browser-execution-confirmation'); await approval.waitFor();
    await expand(approval.locator('details'));
    const visibleReview = JSON.parse(await approval.locator('pre').innerText()); assert.deepEqual(visibleReview, review);
    assert.ok((await approval.innerText()).includes(totalChecks + ' 项声明检查'));
    assert.equal(await execution().getByTestId('browser-execution-start').isDisabled(), true);
    await confirm(stageName + '-single-operation', execution().getByTestId('browser-execution-confirm'));
    const action = await uiWrite(stageName + '-execute', executionPath(), () => execution().getByTestId('browser-execution-start').click(), 202);
    const input = action.body;
    assert.equal(input.candidateId, candidate.id); assert.equal(input.contentDigest, candidate.contentDigest);
    const release = demo.session.metadata.releases.find(item => item.label === label); assert.ok(release);
    assert.equal(input.targetReleaseId, release.id);
    assert.deepEqual(Object.keys(input).sort(), ['operationId', 'expectedGenerationId', 'expectedRevision', 'candidateId', 'contentDigest', 'targetReleaseId'].sort());
    const row = execution().locator('.operations > li').filter({ has: page.locator('strong', { hasText: label }) });
    // The visible target label chooses the row. Internal IDs are read back only.
    await waitFor(async () => await row.count() === 1 && (await row.innerText()).includes('已完成'), label + ' visible completion', 240000);
    assert.ok((await row.locator('code').first().innerText()).includes(input.operationId));
    const result = await uiRead(stageName + '-complete-report', executionPath() + '/' + input.operationId + '/report',
      () => row.getByTestId('browser-execution-open-report').click());
    assert.equal(result.candidateId, candidate.id); assert.equal(result.report.checks.length, totalChecks);
    assert.equal(result.report.coverage.planned, totalChecks); assert.equal(result.report.coverage.completed, totalChecks);
    assert.equal(result.report.coverage.capped, false); assert.equal(result.report.environmentComparison.comparable, true);
    const reportPanel = execution().getByTestId('browser-execution-report');
    await expand(reportPanel.locator('details').filter({ has: page.locator('summary', { hasText: '查看完整完成报告' }) }));
    assert.deepEqual(JSON.parse(await reportPanel.locator('details pre').innerText()), result.report);
    const imageButton = reportPanel.getByTestId('browser-execution-images').first(); assert.equal(await imageButton.count(), 1);
    await imageButton.click();
    await waitFor(() => reportPanel.locator('.images img').evaluateAll(images => images.length === 3
      && images.every(image => image.complete && image.naturalWidth > 0)), label + ' verified source/target/diff images');
    await capture(stageName + '-verified-images', reportPanel.locator('.images'));
    await selectVisible(execution().getByTestId('browser-execution-before'), beforeLabel ? new RegExp('^' + beforeLabel + ' · ') : '首次登记，不声明修复', 'explicit before for ' + label);
    const register = await uiWrite(stageName + '-register', executionPath() + '/' + input.operationId + '/register-result',
      () => execution().getByTestId('browser-execution-register').click(), 200);
    assert.deepEqual(register.body, beforeId ? { beforeOperationId: beforeId } : {});
    const ledger = await readApi(stageName + '-ledger', projectPath() + '/browser-bugs');
    const registered = ledger.entries.find(entry => entry.operationId === input.operationId); assert.ok(registered);
    assert.equal(registered.beforeOperationId, beforeId ?? null);
    const dispatchPath = join(root, 'browser-operations/v1', input.operationId, 'dispatch.json');
    const dispatch = readJson(dispatchPath); assert.deepEqual(dispatch.request, input);
    assert.equal(dispatch.candidate.id, candidate.id); assert.equal(dispatch.candidate.contentDigest, candidate.contentDigest);
    assert.equal(dispatch.contract.scope.length, totalChecks); assert.deepEqual(dispatch.contract.scope, fullReview.review.scope);
    assert.deepEqual(dispatch.contract.rules, fullReview.review.rules);
    assert.deepEqual(dispatch.contract.fixedBaseline.sourceEnvironment, fullReview.review.environment);
    assert.equal(dispatch.contract.fixedBaseline.sourceRunId, source.runId); assert.equal(dispatch.contract.fixedBaseline.sourceSide, 'baseline');
    const value = { label, stageName, input, result, registered, dispatch, dispatchOriginal: fileFact(dispatchPath) };
    operations.push(value); save(stageName + '-operation.json', value);
    const sourceSnapshot = { phase: 'after-' + stageName, referenceRequests: referenceRequests().length,
      files: tree(join(root, source.runId)) };
    sourceSnapshots.push(sourceSnapshot); save(stageName + '-source-originals.json', sourceSnapshot);
    assert.deepEqual(sourceSnapshot.files, sourceBefore, 'Source original bytes changed during fixed execution');
    assert.equal(sourceSnapshot.referenceRequests, sourceReferenceCount, 'Fixed execution must not revisit reference');
    check(stageName + '-same-candidate-fixed-execution-and-explicit-registration', { operationId: input.operationId, totalChecks });
    return value;
  }
  async function openTicket(name) {
    await waitFor(async () => await tickets().getAttribute('aria-busy') === 'false', 'ticket panel ready before read');
    await uiRead(name + '-list-ui', ticketPath(), () => tickets().getByTestId('defect-tickets-refresh').click());
    await waitFor(async () => await tickets().getAttribute('aria-busy') === 'false', 'ticket list refresh complete');
    const button = tickets().getByTestId('defect-ticket-open').filter({ hasText: TICKET_TITLE });
    const visible = await uiRead(name + '-detail-ui', ticketPath() + '/' + ticketId, () => button.click());
    await waitFor(async () => (await tickets().getByTestId('defect-ticket-detail').innerText()).includes(ticketId), 'selected ticket detail');
    const persisted = await readApi(name, ticketPath() + '/' + ticketId);
    assert.deepEqual(visible, persisted, 'Native UI detail must show the same persisted ticket');
    return persisted;
  }
  async function assertTicketStatus(value, passed, handling, verification) {
    assert.equal(value.ticket.counts.total, 2); assert.equal(value.ticket.counts.passed, passed);
    assert.equal(value.ticket.processingStatus, handling); assert.equal(value.ticket.verificationStatus, verification);
    await waitFor(async () => (await tickets().locator('.verification-summary > strong').innerText()).trim() === passed + ' / 2', 'rendered fixed member pass count');
    const handlingLabels = { open: '待处理', closed: '已明确关闭', reopened: '再次发现' };
    const verificationLabels = { still_failed: '仍有可靠失败', partially_passed: '部分检查通过', verified_passed: '关联检查已复验通过' };
    assert.ok(handlingLabels[handling] && verificationLabels[verification]);
    await waitFor(async () => await tickets().getByTestId('defect-ticket-handling').innerText() === '人工处理：' + handlingLabels[handling]
      && await tickets().getByTestId('defect-ticket-verification').innerText() === '当前核验：' + verificationLabels[verification],
    'rendered current manual handling and verification status');
  }
  async function previewTicket(name, operationId) {
    const value = await uiRead(name, ticketPath() + '/' + ticketId + '/close-preview', () => tickets().getByTestId('defect-ticket-preview').click());
    assert.equal(value.preview.afterOperationId, operationId);
    await waitFor(async () => (await tickets().getByTestId('defect-ticket-after').innerText()) === operationId, 'latest registered preview');
    return value.preview;
  }
  const readOnlySnapshot = () => ({ source: tree(join(root, source.runId)), catalog: fileFact(join(root, 'catalog.json')),
    operations: tree(join(root, 'browser-operations')), tickets: tree(join(root, 'defect-tickets')),
    targetRequests: targetRequests(), executePosts: posts().filter(request => request.path === executionPath()).length,
    registerPosts: posts().filter(request => request.path.endsWith('/register-result')).length,
    allPosts: posts().length });
  let binding, sourceReferenceCount;
  event('started', { outputDirectory: OUT, browserPath: 'repository Playwright/CDP', browserAvailability: 'Browser plugin not available',
    process: { node: process.version, execPath: process.execPath, argv: process.argv, cwd: process.cwd() } });
  try {
    inputBefore = currentInputs(); save('input-before.json', inputBefore);
    assert.ok(Object.keys(inputBefore.consoleBundle).includes('index.html'), 'Build this tree console first.');
    demo = await startAcceptanceDemo({ sessionDir: join(OUT, 'session'), open: false });
    base = demo.session.engineOrigin; root = join(demo.session.dataDir, 'acceptance');
    save('launcher-ready-session.json', demo.session);
    assert.equal(demo.session.status, 'ready'); assert.equal(demo.session.metadata.project.name, PROJECT_NAME);
    assert.deepEqual(demo.session.metadata.releases.map(release => release.label), ['参考来源', '已知缺陷', '部分修复', '完全修复']);
    const fresh = await readApi('fresh-project-metadata', projectPath());
    const freshCatalog = await readApi('fresh-catalog-metadata', '/api/acceptance/projects');
    assert.equal(freshCatalog.projects.length, 1); assert.equal(freshCatalog.projects[0].id, fresh.project.id);
    assert.equal(freshCatalog.runBindings.length, 0);
    assert.equal(fresh.schemaVersion, 4); assert.equal(fresh.revision, 5); assert.equal(fresh.releases.length, 4);
    for (const key of ['runBindings', 'candidates', 'approvals', 'selections', 'browserSourceBindings', 'browserCandidates']) assert.equal(fresh[key].length, 0, key);
    assert.equal(fresh.events.length, 5); assert.ok(fresh.events.every(item => ['project-created', 'release-created'].includes(item.kind)));
    assert.equal(fs.existsSync(join(root, 'browser-operations')), false); assert.equal(fs.existsSync(join(root, 'defect-tickets')), false);
    assert.equal(referenceRequests().length, 0); check('fresh-session-only-one-project-four-metadata');

    stage = 'prefill-and-capture'; await startBrowser();
    await page.goto(demo.session.consoleUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '项目验收', exact: true }).click();
    await workbench().waitFor(); assert.equal(page.url(), demo.session.consoleUrl); assert.ok((await page.title()).length > 0);
    assert.equal(await page.locator('vite-error-overlay, #webpack-dev-server-client-overlay').count(), 0);
    const beforePrefill = posts().length;
    await workbench().getByTestId('acceptance-demo-prefill').click();
    await workbench().getByTestId('acceptance-demo-filled').waitFor();
    assert.equal(posts().length, beforePrefill); assert.equal(referenceRequests().length, 0);
    assert.equal(await workbench().locator('[name="acceptance-name"]').inputValue(), SOURCE_NAME);
    assert.equal(await workbench().locator('[name="acceptance-baseline"]').inputValue(), demo.session.fixtureOrigin + '/reference');
    assert.equal(await workbench().locator('[name="acceptance-target"]').inputValue(), demo.session.fixtureOrigin + '/bug');
    assert.equal(await workbench().locator('[name="acceptance-mode"][value="regression"]').isChecked(), true);
    await capturePair('prefilled-form', workbench().locator('.aw-form'));
    const created = await uiWrite('source-capture', '/api/acceptance/runs', () => workbench().getByTestId('acceptance-run').click(), 202);
    source = created.payload;
    assert.equal(created.body.mode, 'regression'); assert.equal(created.body.baselineUrl, demo.session.fixtureOrigin + '/reference');
    assert.equal(created.body.targetUrl, demo.session.fixtureOrigin + '/bug');
    assert.equal(Object.hasOwn(created.body, 'viewports'), false, 'Ordinary builder must retain its standard default viewports');
    await waitFor(async () => {
      const path = join(root, source.runId, 'manifest.json');
      if (!fs.existsSync(path)) return false; const manifest = readJson(path);
      if (['failed', 'cancelled'].includes(manifest.status)) throw Error('Source capture did not complete: ' + json(manifest));
      return manifest.status === 'completed' && manifest;
    }, 'real initial Browser source completed', 240000);
    sourceReport = await readApi('source-complete-report', '/api/acceptance/runs/' + source.runId + '/report');
    assert.equal(sourceReport.gate, 'failed'); assert.equal(sourceReport.status, 'completed');
    await waitFor(async () => (await workbench().getByTestId('acceptance-gate').innerText()).includes('缺陷'), 'original failed comparison visible');
    sourceBefore = tree(join(root, source.runId)); save('source-originals-before.json', sourceBefore);
    sourceReferenceCount = referenceRequests().length; assert.ok(sourceReferenceCount > 0);
    sourceSnapshots.push({ phase: 'after-initial-capture', referenceRequests: sourceReferenceCount, files: sourceBefore });
    check('native-prefill-does-not-run-until-explicit-run');

    stage = 'baseline-binding-and-candidate';
    await expand(catalog());
    await selectVisible(catalog().locator('[name="catalog-project"]'), PROJECT_NAME, 'launcher project');
    await waitFor(async () => !(await page.getByTestId('browser-binding-run').isDisabled()), 'Browser binding ready');
    await selectVisible(page.getByTestId('browser-binding-run'), new RegExp('^' + SOURCE_NAME + ' · '), 'captured comparison');
    await selectVisible(page.getByTestId('browser-binding-side'), 'baseline · 原比较基线侧', 'explicit baseline source side');
    await selectVisible(page.getByTestId('browser-binding-release'), /^参考来源 · /, 'reference metadata version');
    await confirm('baseline-source-attribution', page.getByTestId('browser-binding-confirm'));
    const bound = await uiWrite('baseline-source-binding', projectPath() + '/browser-source-bindings', () => page.getByTestId('browser-binding-submit').click(), 201);
    binding = bound.payload; assert.equal(bound.body.sourceSide, 'baseline'); assert.equal(bound.body.runId, source.runId);
    fullReview = await openCompleteCandidate();
    const saved = await uiWrite('save-browser-candidate', projectPath() + '/browser-baseline-candidates', () => page.getByTestId('browser-candidate-save').click(), 201);
    candidate = saved.payload.candidate; assert.equal(candidate.contentDigest, fullReview.contentDigest);
    assert.equal(saved.body.sourceBindingId, binding.binding.id); assert.equal(saved.body.contentDigest, fullReview.contentDigest);
    const candidateRow = page.getByTestId('browser-candidate-row').filter({ hasText: '参考来源' });
    await candidateRow.waitFor(); assert.equal(await candidateRow.count(), 1);
    const storedReview = await uiRead('saved-candidate-full-readback', projectPath() + '/browser-baseline-candidates/' + candidate.id,
      () => candidateRow.getByTestId('browser-candidate-open').click());
    assert.equal(storedReview.candidate.id, candidate.id); assert.deepEqual(storedReview.review, fullReview.review);
    check('explicit-baseline-full-review-saved-candidate', { totalChecks, viewports: plan.viewports, candidateId: candidate.id, contentDigest: candidate.contentDigest });

    const bug = await execute('已知缺陷', 'bug', null, null);
    assert.equal(bug.result.gate, 'failed');
    const chosen = ['visual', 'behavior'].map(facet => {
      const values = bug.result.report.checks.filter(item => item.identity.facet === facet && item.viewport === desktop.name
        && item.status === 'failed' && item.verdict === 'bug');
      assert.equal(values.length, 1, 'One reliable desktop ' + facet + ' check'); return values[0];
    });
    stage = 'manual-two-member-ticket';
    await expand(tickets().getByTestId('defect-ticket-create-panel'));
    await selectVisible(tickets().getByTestId('defect-tickets-candidate'), /^参考来源 · /, 'manual ticket candidate');
    await selectVisible(tickets().getByTestId('defect-tickets-source'), /^已知缺陷 · /, 'same registered bug operation');
    const visibleSelection = [];
    for (const facet of ['visual', 'behavior']) {
      const dimensions = desktop.width + ' × ' + desktop.height;
      const row = tickets().locator('label.check-row').filter({ hasText: ' · ' + facet + ' · ' + dimensions });
      assert.equal(await row.count(), 1); const checkbox = row.getByTestId('defect-ticket-member');
      visibleSelection.push({ facet, viewport: desktop, label: await row.innerText() }); await checkbox.check();
    }
    assert.equal(await tickets().getByTestId('defect-ticket-member').evaluateAll(items => items.filter(item => item.checked).length), 2);
    await tickets().getByTestId('defect-ticket-title').fill(TICKET_TITLE);
    await selectVisible(tickets().getByTestId('defect-ticket-severity'), '高', 'manual severity');
    await tickets().getByTestId('defect-ticket-description').fill('固定本地示例在桌面布局与菜单展开上存在两项可靠失败，仅关联人工选中的检查。');
    await tickets().getByTestId('defect-ticket-reproduction').fill('打开已知缺陷版本，比较参考布局，然后点击 Menu 核对菜单可见性与 aria-expanded。');
    await confirm('manual-create-two-fixed-members', tickets().getByTestId('defect-ticket-create-confirm'));
    const createdTicket = await uiWrite('manual-ticket-create', ticketPath(), () => tickets().getByTestId('defect-ticket-create').click(), 201);
    ticketId = createdTicket.body.ticketId;
    assert.equal(createdTicket.body.sourceOperationId, bug.input.operationId);
    assert.deepEqual([...createdTicket.body.memberCheckIds].sort(), chosen.map(item => item.id).sort());
    assert.equal(createdTicket.payload.outcome, 'recorded');
    const initialTicket = await openTicket('ticket-initial');
    await assertTicketStatus(initialTicket, 0, 'open', 'still_failed');
    save('manual-visible-member-selection.json', { dimensionsSource: 'complete visible standardized plan', desktop, visibleSelection,
      selectedCheckIds: createdTicket.body.memberCheckIds, event: createdTicket.payload.event });
    await capturePair('manual-ticket-initial', tickets().getByTestId('defect-ticket-detail'));
    check('manual-exact-two-desktop-visual-behavior-members');

    const partial = await execute('部分修复', 'partial', '已知缺陷', bug.input.operationId);
    const partialTicket = await openTicket('ticket-partial');
    await assertTicketStatus(partialTicket, 1, 'open', 'partially_passed');
    const partialPreview = await previewTicket('ticket-partial-preview', partial.input.operationId);
    assert.equal(partialPreview.closeEligible, false);
    assert.equal(await tickets().getByTestId('defect-ticket-confirm').isDisabled(), true);
    assert.equal(await tickets().getByTestId('defect-ticket-close').isDisabled(), true);
    assert.ok((await tickets().getByTestId('defect-ticket-close-preview').innerText()).includes('本次不能关闭'));
    assert.equal(posts().filter(request => request.path === ticketPath() + '/' + ticketId + '/close').length, 0);
    await capturePair('partial-one-of-two-close-disabled', tickets().getByTestId('defect-ticket-detail'));
    check('partial-one-of-two-cannot-close');

    const fixed = await execute('完全修复', 'fixed', '部分修复', partial.input.operationId);
    assert.equal(fixed.result.gate, 'passed');
    const repairedTicket = await openTicket('ticket-fixed-before-manual-close');
    await assertTicketStatus(repairedTicket, 2, 'open', 'verified_passed');
    assert.equal(repairedTicket.ticket.history.length, 1, 'Reliable 2/2 must not auto-close');
    assert.equal(posts().filter(request => request.path === ticketPath() + '/' + ticketId + '/close').length, 0);
    const fixedPreview = await previewTicket('ticket-fixed-preview', fixed.input.operationId);
    assert.equal(fixedPreview.closeEligible, true); assert.equal(fixedPreview.results.length, 2);
    assert.ok((await tickets().getByTestId('defect-ticket-close-preview').innerText()).includes('全部固定成员符合关闭条件'));
    assert.equal(await tickets().getByTestId('defect-ticket-close').isDisabled(), true);
    await capturePair('fixed-two-of-two-still-open', tickets().getByTestId('defect-ticket-detail'));
    stage = 'explicit-close-and-download';
    await tickets().getByTestId('defect-ticket-resolution').fill(RESOLUTION);
    await confirm('manual-explicit-close', tickets().getByTestId('defect-ticket-confirm'));
    const closed = await uiWrite('manual-ticket-close', ticketPath() + '/' + ticketId + '/close', () => tickets().getByTestId('defect-ticket-close').click(), 201);
    assert.equal(closed.body.confirmed, true); assert.equal(closed.body.afterOperationId, fixed.input.operationId);
    for (const key of ['expectedRevision', 'expectedHeadSha256', 'memberSetDigest', 'factsDigest', 'previewDigest']) assert.equal(closed.body[key], fixedPreview[key]);
    assert.equal(closed.payload.outcome, 'recorded'); assert.equal(closed.payload.event.kind, 'close');
    closedTicket = await openTicket('ticket-closed'); await assertTicketStatus(closedTicket, 2, 'closed', 'verified_passed');
    assert.equal(closedTicket.ticket.history.length, 2); assert.equal(closedTicket.ticket.history[1].actionId, closed.body.actionId);
    assert.ok((await tickets().innerText()).includes('不代表整个项目或业务流程已修复'));
    await capturePair('explicitly-closed-ticket', tickets().getByTestId('defect-ticket-detail'));
    check('same-candidate-two-of-two-requires-explicit-close');

    fixedReadOnlyBefore = readOnlySnapshot(); save('read-only-before.json', fixedReadOnlyBefore);
    const downloadAwaited = page.waitForEvent('download');
    const [download] = await Promise.all([downloadAwaited, tickets().getByTestId('defect-ticket-export-md').click()]);
    assert.equal(await download.failure(), null); assert.equal(download.suggestedFilename(), ticketId + '.md');
    const downloadPath = join(OUT, 'downloads', download.suggestedFilename()); await download.saveAs(downloadPath);
    const markdownBytes = fs.readFileSync(downloadPath), markdown = markdownBytes.toString('utf8');
    assert.ok(markdownBytes.length > 0); assert.ok(markdown.includes('关联检查数量：2'));
    assert.ok(markdown.includes('人工处理状态：closed')); assert.ok(markdown.includes('报告 SHA256：' + closedTicket.ticket.source.reportSha256));
    assert.ok(markdown.includes('成员集合 SHA256：' + closedTicket.ticket.memberSetDigest));
    assert.ok(markdown.includes('## 当前逐项核验') && markdown.includes('## 人工处理历史') && markdown.includes('固定关联'));
    for (const selected of chosen) assert.ok(markdown.includes(selected.id.replaceAll('-', '\\-')));
    assert.ok(markdown.includes('revision 0') && markdown.includes('revision 1') && markdown.includes('verified\\_passed'));
    downloadFact = { suggestedFilename: download.suggestedFilename(), path: relative(OUT, downloadPath).replaceAll('\\', '/'),
      ...fileFact(downloadPath), markdownIncludesSourceAndMemberDigests: true };
    save('download-verification.json', downloadFact);
    // Native read controls and direct GET readbacks must not execute or register.
    await uiRead('final-ticket-list-ui', ticketPath(), () => tickets().getByTestId('defect-tickets-refresh').click());
    await waitFor(async () => await tickets().getAttribute('aria-busy') === 'false', 'final ticket UI read complete');
    const finalOperations = await uiRead('final-execution-list-ui', executionPath(),
      () => execution().getByTestId('browser-execution-refresh').click());
    assert.equal(finalOperations.operations.length, 3);
    const finalVisibleLedger = await uiRead('final-browser-ledger-ui', projectPath() + '/browser-bugs',
      () => execution().getByTestId('browser-bugs-refresh').click());
    const finalLedger = await readApi('final-browser-ledger', projectPath() + '/browser-bugs');
    assert.deepEqual(finalVisibleLedger, finalLedger, 'Native ledger read must match persisted registration facts');
    const finalProject = await readApi('final-project', projectPath());
    assert.equal(finalLedger.entries.length, 3); assert.equal(finalProject.browserCandidates.length, 1);
    assert.equal(finalProject.browserSourceBindings.length, 1); assert.equal(finalProject.releases.length, 4);
    await flush(); fixedReadOnlyAfter = readOnlySnapshot(); save('read-only-after.json', fixedReadOnlyAfter);
    assert.deepEqual(fixedReadOnlyAfter, fixedReadOnlyBefore, 'Read/download must leave source/catalog/operations/tickets and execution counts unchanged');
    const exported = browserRequests.filter(request => request.method === 'GET' && request.path === ticketPath() + '/' + ticketId + '/export.md');
    assert.equal(exported.length, 1); const exportedResponse = responses.find(response => response.requestSequence === exported[0].sequence);
    assert.ok(exportedResponse?.raw, 'Preserve actual UI export response bytes');
    assert.equal(exportedResponse.status, 200); assert.equal(exportedResponse.raw.sha256, downloadFact.sha256);
    assert.equal(exportedResponse.raw.bytes, downloadFact.bytes);
    sourceAfter = tree(join(root, source.runId)); save('source-originals-after.json', sourceAfter);
    assert.deepEqual(sourceAfter, sourceBefore); assert.equal(referenceRequests().length, sourceReferenceCount);
    check('actual-markdown-download-and-read-only-zero-additional-execution');

    const writes = posts();
    assert.equal(writes.length, 11, 'One capture, binding, candidate, three execute/register pairs, create and close only');
    assert.equal(writes.filter(request => request.path === '/api/acceptance/runs').length, 1);
    assert.equal(writes.filter(request => request.path === executionPath()).length, 3);
    assert.equal(writes.filter(request => request.path.endsWith('/register-result')).length, 3);
    assert.equal(writes.filter(request => request.path.endsWith('/triage')).length, 0);
    assert.deepEqual(confirmations.map(value => value.name), ['baseline-source-attribution', 'candidate-save', 'bug-single-operation',
      'manual-create-two-fixed-members', 'partial-single-operation', 'fixed-single-operation', 'manual-explicit-close']);
    assert.equal(pageErrors.length, 0, 'Ordinary page errors must be zero');
    assert.equal(consoleMessages.length, 0, 'Ordinary warning/error console messages must be zero');
    assert.equal(captureFailures.length, 0, 'Evidence capture tasks must complete');
    assert.equal(responses.filter(response => response.status >= 400).length, 0, 'Ordinary acceptance HTTP responses must not fail');
    const writeSequences = new Set(writes.map(request => request.sequence));
    assert.equal(requestFailures.filter(item => writeSequences.has(item.requestSequence)).length, 0, 'No normal UI write may fail transport');
    inputAfter = currentInputs(); save('input-after.json', inputAfter); assert.deepEqual(inputAfter, inputBefore, 'Run used immutable maintained input and built console bytes');
    check('native-ui-only-writes-and-zero-ordinary-console-errors');
  } catch (error) {
    failure = errorOf(error); event('failure', { error: failure });
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: join(OUT, 'screenshots/failure.png'), fullPage: true }); save('failure-dom.txt', await page.locator('body').innerText()); }
      catch (captureError) { captureFailures.push({ kind: 'failure-capture', error: errorOf(captureError) }); }
    }
  } finally {
    stage = 'cleanup';
    try { await flush(); } catch (error) { cleanupErrors.push(errorOf(error)); }
    try { await context?.close(); } catch (error) { cleanupErrors.push(errorOf(error)); }
    try { await browser?.close(); } catch (error) { cleanupErrors.push(errorOf(error)); }
    if (chromiumProcess && chromiumProcess.exitCode === null && chromiumProcess.signalCode === null) {
      try {
        const exited = new Promise(ready => chromiumProcess.once('exit', ready));
        chromiumProcess.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
        if (chromiumProcess.exitCode === null && chromiumProcess.signalCode === null) {
          if (process.platform === 'win32') await new Promise(ready => {
            const child = spawn('taskkill', ['/PID', String(chromiumProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            child.once('error', ready); child.once('exit', ready);
          }); else chromiumProcess.kill('SIGKILL');
          await Promise.race([exited, delay(3000)]);
        }
        assert.ok(chromiumProcess.exitCode !== null || chromiumProcess.signalCode !== null, 'Owned Chromium must stop');
      } catch (error) { cleanupErrors.push(errorOf(error)); }
    }
    if (demo) {
      try {
        demoTerminal = await demo.close('ui-smoke-complete');
        save('launcher-terminal.json', demoTerminal);
        assert.equal(demoTerminal.status, 'stopped', 'Owned launcher must report a complete successful terminal stop');
      } catch (error) { cleanupErrors.push(errorOf(error)); }
    }
    await flush();
    save('ui-requests.json', browserRequests); save('ui-responses.json', responses);
    save('request-failures.json', requestFailures); save('capture-failures.json', captureFailures);
    save('page-errors.json', pageErrors); save('console-messages.json', consoleMessages);
    save('ui-confirmations.json', confirmations); save('layout-checks.json', layouts); save('ui-actions.json', actions);
    save('source-snapshots.json', sourceSnapshots);
    if (demo) { try { save('target-requests-final.json', targetRequests()); } catch (error) { cleanupErrors.push(errorOf(error)); } }
    if (!inputAfter && inputBefore) { try { inputAfter = currentInputs(); save('input-after-failure.json', inputAfter); } catch (error) { cleanupErrors.push(errorOf(error)); } }
    // Runtime and browser profile originals remain untouched in OUT. Inventory
    // only portable evidence here; its boundaries and its own digest are explicit.
    const inventoryExcludes = ['chromium-profile', 'session/runtime', 'summary.json', 'evidence-file-digests.json'];
    let evidenceInventory = null;
    try {
      evidenceInventory = save('evidence-file-digests.json', { schemaVersion: 1,
        scope: 'Portable evidence files only; original runtime/profile directories are retained and excluded, as are this manifest and the final summary.',
        excludedPaths: inventoryExcludes, files: tree(OUT, new Set(inventoryExcludes)) });
    } catch (error) { cleanupErrors.push(errorOf(error)); }
    const summary = { schemaVersion: 1, kind: 'local-fixed-demo-native-ui-closure', startedAt, endedAt: new Date().toISOString(),
      accepted: !failure && cleanupErrors.length === 0 && captureFailures.length === 0 && pageErrors.length === 0 && consoleMessages.length === 0
        && responses.every(response => response.status < 400) && demoTerminal?.status === 'stopped',
      scope: '本地固定示例；真实Browser执行；人工固定两成员；不代表外部泛化或AI推理。',
      browserAvailability: 'Browser plugin not available', browserPath: 'repository Playwright/CDP',
      outputDirectory: OUT, sessionDirectory: demo?.sessionDir ?? null, demoTerminal: demoTerminal ?? null,
      failure, cleanupErrors, evidenceInventory, inventoryExcludes, checks,
      totalDeclaredChecks: totalChecks ?? null, planViewports: plan?.viewports ?? null,
      project: demo?.session.metadata.project ?? null, candidate: candidate ?? null, sourceRunId: source?.runId ?? null,
      sourceComparisonGate: sourceReport?.gate ?? null, sourceReferenceCount: sourceReferenceCount ?? null,
      sourceOriginalsUnchanged: !!sourceBefore && !!sourceAfter && JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
      operations: operations.map(value => ({ label: value.label, operationId: value.input.operationId, candidateId: value.input.candidateId,
        contentDigest: value.input.contentDigest, targetReleaseId: value.input.targetReleaseId, beforeOperationId: value.registered.beforeOperationId,
        gate: value.result.gate, checkCount: value.result.report.checks.length })),
      ticketId: ticketId ?? null, closedTicket: closedTicket?.ticket ?? null, download: downloadFact ?? null,
      explicitConfirmations: confirmations, browserPostCount: posts().length, pageErrors, consoleMessages,
      requestFailureCount: requestFailures.length, captureFailureCount: captureFailures.length,
      httpFailureCount: responses.filter(response => response.status >= 400).length, layouts,
      maintainedInputUnchanged: !!inputBefore && !!inputAfter && JSON.stringify(inputBefore) === JSON.stringify(inputAfter),
      readOnlyUnchanged: !!fixedReadOnlyBefore && !!fixedReadOnlyAfter && JSON.stringify(fixedReadOnlyBefore) === JSON.stringify(fixedReadOnlyAfter) };
    save('summary.json', summary);
    console.log(JSON.stringify({ event: 'completed', accepted: summary.accepted, outputDirectory: OUT, failure, cleanupErrors }));
    if (!summary.accepted) throw new Error('D7 native UI smoke failed; all original evidence retained at ' + OUT,
      { cause: failure ? new Error(failure.message) : new Error('Final evidence or cleanup requirements failed') });
    return summary;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  if (process.argv.length > 3) { console.error('Usage: node core/scripts/smoke-acceptance-demo-console.mjs [fresh-output-directory]'); process.exitCode = 1; }
  else if (process.argv[2] === '--help') console.log('Usage: node core/scripts/smoke-acceptance-demo-console.mjs [fresh-output-directory]\nStarts one fresh local demo, then performs the complete production UI flow. Build this tree console first.');
  else runAcceptanceDemoConsoleSmoke({ outDir: process.argv[2] }).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
