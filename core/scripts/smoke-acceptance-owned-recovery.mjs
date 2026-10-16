#!/usr/bin/env node
/** Real engine startup + Chromium CDP reads of controlled recovery facts.
 * No executor or target/model request is used to reconstruct interrupted runs. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { CORE, recoveryFixture, facts, json, waitFor } from './fixtures/owned-recovery.mjs';

const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'owned-recovery-' + randomUUID()));
assert.equal(fs.existsSync(OUT), false, 'Use a new output directory to preserve prior evidence.');
assert.ok(fs.existsSync(resolve(CORE, '..', 'console', 'dist', 'index.html')), 'Build console/dist before the recovery smoke.');
fs.mkdirSync(OUT, { recursive: true });
const save = (name, value) => fs.writeFileSync(join(OUT, name), typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value, null, 2) + '\n');
const token = 'owned-recovery-controlled-fixture', fixtures = [], checks = {}, pageErrors = [], browserRequests = [];
let browser, chromiumProcess, chromiumLog = '', page;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function apiJson(engine, path) {
  const response = await engine.get(path); assert.equal(response.status, 200, path); return response.json();
}
function noExecution(f) { assert.deepEqual(f.requests, []); assert.deepEqual(f.modelRequests, []); }
try {
  const healthy = await recoveryFixture(); fixtures.push(healthy);
  const managed = healthy.prepare({ start: true }), legacy = healthy.legacy(), prepared = healthy.prepare();
  const before = facts(healthy.root);
  save('healthy-facts-before.json', before); save('managed-manifest-before.json', json(managed.manifestPath));
  save('managed-dispatch.json', managed.bytes); save('prepared-only-dispatch.json', prepared.bytes);
  const engine = await healthy.startEngine({ token, consoleDir: resolve(CORE, '..', 'console', 'dist') });
  const recovery = await apiJson(engine, '/api/acceptance/recovery');
  assert.deepEqual(recovery, { schemaVersion: 1, ready: true, status: 'ready',
    counts: { managedInterrupted: 1, legacyInterrupted: 1, prepared: 1, skipped: 0, totalInterrupted: 2 }, code: null });
  const managedHead = json(managed.manifestPath), legacyHead = json(join(healthy.root, legacy.runId, 'manifest.json'));
  assert.equal(managedHead.status, 'interrupted'); assert.equal(managedHead.gate, 'blocked');
  assert.equal(managedHead.reasonCode, 'ENGINE_RESTARTED'); assert.equal(legacyHead.status, 'interrupted');
  const after = facts(healthy.root), expectedChanges = [managed.envelope.runId, legacy.runId].map(id => id + '/manifest.json').sort();
  assert.deepEqual(Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name])).sort(), expectedChanges);
  assert.equal(fs.existsSync(prepared.dir), false); assert.equal((await apiJson(engine, '/api/status')).acceptance, null);
  const jobs = await apiJson(engine, '/api/jobs'); assert.deepEqual(jobs.jobs, []); assert.deepEqual(jobs.history, []);
  save('recovery-ready.json', recovery); save('managed-manifest-interrupted.json', managedHead);
  save('legacy-manifest-interrupted.json', legacyHead); save('healthy-facts-after.json', after); save('jobs-ready.json', jobs);
  checks.ownedMixedStartupAndPreparedUntouched = true; noExecution(healthy);

  // Launch the installed Chromium explicitly, then attach through the actual
  // DevTools HTTP endpoint rather than a Playwright browser-server transport.
  const profile = join(healthy.parent, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; });
  chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const activePort = join(profile, 'DevToolsActivePort');
  await waitFor(() => {
    if (chromiumProcess.exitCode !== null || chromiumProcess.signalCode !== null) throw new Error('Chromium exited: ' + chromiumLog);
    return fs.existsSync(activePort) && fs.readFileSync(activePort, 'utf8').split('\n')[0];
  });
  const cdpBase = 'http://127.0.0.1:' + fs.readFileSync(activePort, 'utf8').split('\n')[0];
  const cdpVersion = await (await fetch(cdpBase + '/json/version')).json();
  browser = await chromium.connectOverCDP(cdpBase);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    extraHTTPHeaders: { 'x-heimdall-token': token } });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/acceptance/')) browserRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  await page.goto(engine.base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator(`[data-run-id="${managed.envelope.runId}"]`).click();
  await page.locator('.aw-failed').waitFor();
  assert.match(await page.locator('.aw-failed').innerText(), /验收已中断/);
  assert.equal(await page.getByTestId('acceptance-gate').count(), 0);
  assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  await page.screenshot({ path: join(OUT, 'owned-recovery-interrupted-desktop.png'), fullPage: false });
  save('browser-interrupted-state.json', { runId: managed.envelope.runId, text: await page.locator('.aw-failed').innerText(),
    reportGateCount: await page.getByTestId('acceptance-gate').count(), triageCount: await page.getByTestId('acceptance-triage').count() });
  const recoveryPage = await context.newPage();
  const recoveryResponse = await recoveryPage.goto(engine.base + '/api/acceptance/recovery', { waitUntil: 'networkidle' });
  assert.deepEqual(await recoveryResponse.json(), recovery);
  await recoveryPage.screenshot({ path: join(OUT, 'owned-recovery-ready-api.png'), fullPage: false });
  checks.cdpInterruptedUiAndRecoveryGet = true;
  assert.deepEqual(facts(healthy.root), after); assert.deepEqual(pageErrors, []);
  assert.equal(browserRequests.some(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)), false);
  await engine.stop();
  const restarted = await healthy.startEngine({ token });
  const again = await apiJson(restarted, '/api/acceptance/recovery');
  assert.deepEqual(again, { schemaVersion: 1, ready: true, status: 'ready',
    counts: { managedInterrupted: 0, legacyInterrupted: 0, prepared: 1, skipped: 2, totalInterrupted: 0 }, code: null });
  assert.deepEqual(facts(healthy.root), after); assert.equal(fs.existsSync(prepared.dir), false); noExecution(healthy);
  save('recovery-restarted.json', again); checks.restartIsByteIdempotent = true;

  const damaged = await recoveryFixture(); fixtures.push(damaged);
  const damagedRun = damaged.prepare({ start: true }), damagedLegacy = damaged.legacy(), damagedPrepared = damaged.prepare();
  fs.writeFileSync(damagedPrepared.sidecar, '{controlled damaged dispatch');
  const damagedBefore = facts(damaged.root), blockedEngine = await damaged.startEngine({ token });
  const blocked = await apiJson(blockedEngine, '/api/acceptance/recovery');
  assert.deepEqual(blocked, { schemaVersion: 1, ready: false, status: 'blocked', counts: null, code: 'ACCEPTANCE_RECOVERY_BLOCKED' });
  const catalog = await apiJson(blockedEngine, '/api/acceptance/projects');
  assert.ok(catalog.projects.some(project => project.id === damaged.project.id));
  const mutation = await blockedEngine.get('/api/acceptance/runs', { method: 'POST', body: JSON.stringify({ ...damaged.legacyInput, managed: null }) });
  assert.equal(mutation.status, 503); const mutationBody = await mutation.json(); assert.equal(mutationBody.code, 'ACCEPTANCE_RECOVERY_BLOCKED');
  const blockedCatalogMutation = await blockedEngine.get('/api/acceptance/projects', { method: 'POST', body: '{}' });
  assert.equal(blockedCatalogMutation.status, 503);
  assert.deepEqual(facts(damaged.root), damagedBefore);
  assert.equal(json(damagedRun.manifestPath).status, 'running');
  assert.equal(json(join(damaged.root, damagedLegacy.runId, 'manifest.json')).status, 'running');
  const blockedJobs = await apiJson(blockedEngine, '/api/jobs'); assert.deepEqual(blockedJobs.jobs, []); assert.deepEqual(blockedJobs.history, []);
  save('recovery-blocked.json', blocked); save('blocked-catalog.json', catalog); save('blocked-mutation.json', { status: mutation.status, body: mutationBody });
  save('blocked-facts-before.json', damagedBefore); save('blocked-facts-after.json', facts(damaged.root)); save('jobs-blocked.json', blockedJobs);
  const blockedResponse = await recoveryPage.goto(blockedEngine.base + '/api/acceptance/recovery', { waitUntil: 'networkidle' });
  assert.deepEqual(await blockedResponse.json(), blocked);
  await recoveryPage.screenshot({ path: join(OUT, 'owned-recovery-blocked-api.png'), fullPage: false });
  const catalogResponse = await recoveryPage.goto(blockedEngine.base + '/api/acceptance/projects', { waitUntil: 'networkidle' });
  assert.deepEqual(await catalogResponse.json(), catalog);
  await recoveryPage.screenshot({ path: join(OUT, 'owned-recovery-blocked-catalog.png'), fullPage: false });
  noExecution(damaged); checks.corruptNamespaceBlocksWritesAndPreservesCatalogReads = true;
  save('target-requests.json', fixtures.map((f, index) => ({ fixture: index, requests: f.requests, modelRequests: f.modelRequests })));
  save('browser-requests.json', browserRequests);
  save('runtime.json', { node: process.version, platform: process.platform, architecture: process.arch,
    chromium: cdpVersion.Browser, protocol: cdpVersion['Protocol-Version'], transport: 'Chromium DevTools Protocol over loopback HTTP' });
  const result = { status: 'passed', evidenceLevel: 'real-engine-cdp-browser-local-fixture', engineRecoveryTested: true,
    engineExecutorTested: false, scope: 'Archived validated dispatch template with varied fixture IDs/local target; real owner/writer and engine startup. Catalog approval admission is outside this smoke.',
    checks, pageErrors, zeroTargetRequests: true, zeroModelRequests: true, outputDirectory: OUT };
  save('browser-checks.json', result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  save('failure.json', { message: error.message, stack: error.stack, checks, pageErrors });
  if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {}); await stopChild(chromiumProcess); save('chromium.log', chromiumLog);
  for (const [index, fixture] of fixtures.entries()) {
    for (const [engineIndex, engine] of fixture.engines.entries()) save(`engine-${index}-${engineIndex}.log`, engine.output());
    await fixture.cleanup();
  }
}
