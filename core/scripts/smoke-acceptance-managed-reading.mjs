#!/usr/bin/env node
/** Real browser over real prepared/written facts. The engine executor stays
 * disabled: this fixture invokes the runner explicitly before engine startup. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';
import { createAcceptanceRun, finishAcceptanceRun } from '../src/acceptance/store.mjs';
import { createManagedAcceptanceRun, finishManagedAcceptanceRun, updateManagedAcceptanceProgress } from '../src/acceptance/managed-run-store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { acceptanceMarkdown } from '../src/acceptance/report.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'managed-reading-' + randomUUID()));
assert.equal(existsSync(OUT), false, 'Use a new output directory to preserve prior evidence.');
mkdirSync(OUT, { recursive: true });
const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-managed-reading-'))), root = join(dataRoot, 'acceptance');
const token = 'managed-reading-local-fixture', headers = { 'Content-Type': 'application/json', 'x-heimdall-token': token };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFileSync(join(OUT, name), typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value, null, 2) + '\n');
const cas = catalog => { const c = catalog.read(); return { expectedGenerationId: c.generationId, expectedRevision: c.revision }; };
const sleep = ms => new Promise(ready => setTimeout(ready, ms));
async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error('Managed reading smoke timed out: ' + (last?.message ?? 'state not reached'));
}
async function listen(server) { await new Promise(ready => server.listen(0, '127.0.0.1', ready)); return server.address().port; }
const requests = [], pageErrors = [], checks = {}, runIds = [];
const fixture = createServer((req, res) => {
  requests.push({ method: req.method, url: req.url }); res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: req.url.endsWith('/bug') ? 9 : 0 }));
});
let owner, engine, browser, engineLog = '';
try {
  const target = 'http://127.0.0.1:' + await listen(fixture);
  owner = acquireAcceptanceOwner({ root });
  const catalog = createAcceptanceCatalogStore({ root, owner }); await catalog.initialize();
  const project = (await catalog.createProject({ ...cas(catalog), name: '托管验收结果读取夹具' })).project;
  const sourceRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: '需求来源', targetUrl: target + '/source' })).release;
  const targetRelease = (await catalog.createRelease(project.id, { ...cas(catalog), label: '待验收版本', targetUrl: target + '/target' })).release;
  const source = createAcceptanceRun({ name: '托管验收结果', mode: 'spec', targetUrl: sourceRelease.targetUrl,
    spec: { source: { id: 'MANAGED-READ', revision: '1' }, approved: false,
      checks: ['/healthy', '/bug'].map((path, index) => ({ id: 'READ-' + index, title: index ? '业务码符合需求' : '健康响应',
        method: 'GET', path, severity: 'high', expect: { status: 200, contentType: 'application/json',
          json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })) } }, { root });
  runIds.push(source.runId);
  finishAcceptanceRun(source.runId, await runSpecAcceptance(source.plan, { runId: source.runId, outputDir: join(root, source.runId) }), { root });
  const sourceDigests = () => Object.fromEntries(readdirSync(join(root, source.runId)).sort().map(name => [name, hash(readFileSync(join(root, source.runId, name)))]));
  const beforeSource = sourceDigests();
  await catalog.bindRun(project.id, { ...cas(catalog), runId: source.runId, releaseId: sourceRelease.id });
  const candidate = (await catalog.createBaselineCandidate(project.id, { ...cas(catalog), mode: 'spec', sourceSide: 'source', sourceRunId: source.runId })).candidate;
  const approval = (await catalog.approveBaseline(project.id, { ...cas(catalog), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: 'fixture review' })).approval;
  const selection = (await catalog.selectBaseline(project.id, { ...cas(catalog), mode: 'spec', approvalId: approval.id, contentDigest: candidate.contentDigest, reason: 'fixture selection' })).selection;
  const prepare = async () => {
    const { record } = await catalog.prepareManagedSpecDispatch(project.id, { ...cas(catalog), operationId: 'ao-' + randomUUID(),
      selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id });
    const envelope = JSON.parse(record.bytes.toString('utf8'));
    save(envelope.operationId + '.json', record.bytes);
    return { envelope, ref: { operationId: envelope.operationId, dispatchSha256: record.sha256 } };
  };
  const completed = await prepare(), options = { owner, assertActive: () => true };
  createManagedAcceptanceRun(completed.ref, options); runIds.push(completed.envelope.runId);
  assert.equal(requests.length, 0, 'Preparation and creation never invoke target APIs.');
  const report = finishManagedAcceptanceRun(completed.ref, await runSpecAcceptance(completed.envelope.plan,
    { runId: completed.envelope.runId, outputDir: join(root, completed.envelope.runId) }), options);
  assert.equal(report.gate, 'failed'); assert.equal(report.summary.bugs, 1); assert.equal(requests.length, 2);
  // A forged/unreferenced Markdown file must not supply any download bytes.
  writeFileSync(join(root, completed.envelope.runId, 'report.md'), 'UNTRUSTED STORED MARKDOWN');
  const running = await prepare(); createManagedAcceptanceRun(running.ref, options); runIds.push(running.envelope.runId);
  updateManagedAcceptanceProgress(running.ref, { progress: { kind: 'acceptance-started', total: 2, completed: 0 } }, options);
  const prepared = await prepare();
  assert.equal(existsSync(join(root, prepared.envelope.runId)), false);
  const beforeHeads = Object.fromEntries(runIds.flatMap(runId => ['manifest.json', 'report.json'].filter(name => existsSync(join(root, runId, name)))
    .map(name => [runId + '/' + name, hash(readFileSync(join(root, runId, name)))])));
  owner.release(); owner = null;
  const reservation = createServer(), port = await listen(reservation);
  await new Promise(ready => reservation.close(ready));
  const base = 'http://127.0.0.1:' + port;
  engine = spawn(process.execPath, ['src/engine-server.mjs', String(port)], { cwd: CORE, env: { ...process.env,
    HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: resolve(CORE, '..', 'console', 'dist'), HEIMDALL_HOST: '127.0.0.1',
    HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0', HEIMDALL_ENV_FILE: join(dataRoot, 'missing.env') }, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.stdout.on('data', bytes => { engineLog += bytes; }); engine.stderr.on('data', bytes => { engineLog += bytes; });
  const api = path => fetch(base + '/api/acceptance/runs' + path, { headers });
  await waitFor(async () => (await api('')).ok);
  const detail = await (await api('/' + completed.envelope.runId)).json();
  assert.equal(detail.plan, undefined); assert.equal(detail.managed, undefined); assert.equal(detail.triageSupported, false);
  assert.equal((await (await api('/' + running.envelope.runId)).json()).status, 'interrupted');
  const interruptedPath = running.envelope.runId + '/manifest.json';
  const interrupted = JSON.parse(readFileSync(join(root, interruptedPath), 'utf8'));
  assert.equal(interrupted.reasonCode, 'ENGINE_RESTARTED');
  // Startup owns this single lifecycle change; subsequent reads stay read-only.
  assert.notEqual(hash(readFileSync(join(root, interruptedPath))), beforeHeads[interruptedPath]);
  beforeHeads[interruptedPath] = hash(readFileSync(join(root, interruptedPath)));
  checks.safeHeadAndRealLifecycle = true;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('heimdall-token', value), token);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.ok(await page.title());
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  await page.locator(`[data-run-id="${completed.envelope.runId}"]`).click();
  await page.getByTestId('acceptance-gate').waitFor();
  assert.match(await page.getByTestId('acceptance-gate').innerText(), /缺陷/);
  assert.equal(await page.getByTestId('acceptance-triage').count(), 0);
  assert.equal(await page.getByText('此报告暂不支持 AI 解读。可下载报告与证据继续排查。', { exact: true }).count(), 1);
  checks.completedBugVisibleAndTriageUnavailable = true;
  const bug = report.checks.find(check => check.verdict === 'bug'), evidence = page.locator(`details[data-check-id="${bug.id}"]`);
  await evidence.locator('summary').click();
  await waitFor(async () => await evidence.locator('.aw-json-evidence').count() === 3);
  checks.referencedEvidenceRendered = true;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  await (await download).saveAs(join(OUT, 'downloaded-report.md'));
  assert.equal(readFileSync(join(OUT, 'downloaded-report.md'), 'utf8'), acceptanceMarkdown(report));
  const reportResponse = await api('/' + completed.envelope.runId + '/report');
  assert.equal(reportResponse.headers.get('cache-control'), 'no-store'); assert.equal(reportResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await reportResponse.arrayBuffer()), readFileSync(join(root, completed.envelope.runId, 'report.json')));
  checks.downloadUsesVerifiedJsonAndDerivedMarkdown = true;
  await page.locator('#aw-result-panel').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, 'managed-reading-desktop.png'), fullPage: false });
  await page.locator(`[data-run-id="${running.envelope.runId}"]`).click();
  await page.locator('.aw-failed').waitFor();
  assert.match(await page.locator('.aw-failed').innerText(), /验收已中断/);
  assert.equal(await page.getByTestId('acceptance-gate').count(), 0);
  checks.recoveredInterruptionIsNotCompleted = true;
  await page.locator(`[data-run-id="${completed.envelope.runId}"]`).click(); await page.getByTestId('acceptance-gate').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('acceptance-view-results').click();
  await page.waitForFunction(() => document.querySelector('#aw-result-panel').getBoundingClientRect().top < 200);
  const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    results: document.querySelector('#aw-result-panel').scrollWidth, resultWidth: document.querySelector('#aw-result-panel').clientWidth }));
  assert.ok(layout.document <= layout.width + 1 && layout.results <= layout.resultWidth + 1);
  await page.screenshot({ path: join(OUT, 'managed-reading-mobile.png'), fullPage: false });
  checks.mobileNoOverflow = true;
  assert.equal(await page.locator('vite-error-overlay').count(), 0); assert.deepEqual(pageErrors, []);
  assert.deepEqual(sourceDigests(), beforeSource);
  for (const [file, sha256] of Object.entries(beforeHeads)) assert.equal(hash(readFileSync(join(root, file))), sha256);
  assert.equal(existsSync(join(root, prepared.envelope.runId)), false); assert.equal(requests.length, 2);
  checks.readingNeverExecutesOrRewritesFacts = true;
  save('source-digests.json', beforeSource); save('head-digests.json', beforeHeads); save('fixture-requests.json', requests);
  const result = { status: 'passed', evidenceLevel: 'real-browser-local-fixture',
    scope: 'Real preparation + explicit internal runner/writer before engine startup; startup settles running to interrupted and browser only reads. No engine executor tested.',
    browserPath: 'Playwright', engineExecutorTested: false, engineRecoveryTested: true,
    runIds, preparedUnstarted: prepared.envelope.runId, checks, layout, pageErrors };
  save('browser-checks.json', result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  save('failure.json', { message: error.message, pageErrors }); throw error;
} finally {
  await browser?.close();
  if (engine && engine.exitCode === null) {
    const exited = new Promise(ready => engine.once('exit', ready)); engine.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (engine.exitCode === null && engine.signalCode === null) { engine.kill('SIGKILL'); await exited; }
  }
  owner?.release(); save('engine.log', engineLog);
  for (const runId of runIds) if (existsSync(join(root, runId))) cpSync(join(root, runId), join(OUT, 'run-evidence', runId), { recursive: true });
  fixture.closeAllConnections(); await new Promise(ready => fixture.close(ready));
  assert.ok(dataRoot.startsWith(realpathSync(tmpdir()) + sep) && dataRoot.includes('heimdall-managed-reading-'));
  rmSync(dataRoot, { recursive: true, force: true });
}
