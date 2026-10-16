#!/usr/bin/env node
/**
 * B2.0 migration smoke using immutable, committed B1 8353595 real-run artifacts.
 * Starts real engines and Chromium against copied data only. No new acceptance
 * worker, candidate, approval, selection or target request is intentionally run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(CORE, '..');
const FIXTURE_RELATIVE = 'docs/audits/2026-10-16/evidence/acceptance-catalog/console';
const FIXTURE = join(REPO, FIXTURE_RELATIVE);
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'acceptance-catalog-migration',
  new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
const TOKEN = 'acceptance-catalog-migration-local-fixture';
const HEADERS = { 'content-type': 'application/json', 'x-heimdall-token': TOKEN };
const checks = {}, apiCases = [], layouts = [], errors = [], targetAttempts = [], tempRoots = [], children = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(ready => setTimeout(ready, ms));
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'));
const version = catalog => ({ expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision });
let browser, active, outputReady = false;

function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  for (const root of [...tempRoots].sort((a, b) => b.length - a.length)) {
    for (const spelling of [root, root.replaceAll('\\', '/'), JSON.stringify(root).slice(1, -1), pathToFileURL(root).href]) text = text.replaceAll(spelling, '[temporary-data-root]');
  }
  return text;
}
const save = (name, value) => writeFileSync(join(OUT, name), redact(value));

function treeDigests(root) {
  const entries = {};
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, 'Fixture trees must not contain symbolic links.');
      if (stat.isDirectory()) walk(path);
      else {
        assert.ok(stat.isFile(), 'Fixture trees contain only regular files.');
        entries[relative(root, path).split(sep).join('/')] = digest(readFileSync(path));
      }
    }
  }
  walk(root);
  return entries;
}

function createDataRoot(omitRunId = null) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-acceptance-catalog-migration-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'acceptance'));
  cpSync(join(FIXTURE, 'catalog-storage.json'), join(root, 'acceptance', 'catalog.json'));
  for (const id of readdirSync(join(FIXTURE, 'run-evidence')).sort()) {
    if (id !== omitRunId) cpSync(join(FIXTURE, 'run-evidence', id), join(root, 'acceptance', id), { recursive: true, errorOnExist: true });
  }
  return root;
}

function copiedRunDigests(root) {
  const result = {};
  for (const id of readdirSync(join(root, 'acceptance')).filter(name => /^ac-/.test(name)).sort()) {
    for (const [name, sha256] of Object.entries(treeDigests(join(root, 'acceptance', id)))) result[id + '/' + name] = sha256;
  }
  return result;
}

async function waitFor(fn, label, timeoutMs = 30_000) {
  let last;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (problem) { last = problem; }
    await delay(100);
  }
  throw new Error(`Migration smoke timed out (${label}): ${last?.message ?? 'state not reached'}`);
}

async function freePort(excludedPorts) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer();
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const port = server.address().port;
    await new Promise(ready => server.close(ready));
    if (!excludedPorts.has(String(port))) return port;
  }
  throw new Error('Could not reserve an engine port outside the old fixture origins.');
}

async function stop(record) {
  if (!record || record.child.exitCode !== null || record.child.signalCode !== null) return;
  const ended = new Promise(ready => record.child.once('exit', ready));
  record.child.kill('SIGTERM');
  await Promise.race([ended, delay(5000)]);
  if (record.child.exitCode === null && record.child.signalCode === null) {
    record.child.kill('SIGKILL');
    await Promise.race([ended, delay(5000)]);
  }
  assert.ok(record.child.exitCode !== null || record.child.signalCode !== null, 'Engine stopped before root reuse.');
}

// A private engine preload denies and counts old fixture traffic from node fetch
// and node:http(s), in addition to Chromium's route guard below. It lives only in
// this smoke's disposable root, never in committed artifacts or the run store.
function writeNetworkGuard(root, origins) {
  const path = join(root, 'old-target-guard.mjs');
  writeFileSync(path, `import http from 'node:http';
import https from 'node:https';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const origins = new Set(${JSON.stringify(origins)});
const trace = ${JSON.stringify(join(root, 'old-target-attempts.jsonl'))};
function deny(input, protocol, channel) {
  let url;
  try {
    url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : input?.url ? new URL(input.url)
      : new URL((input?.protocol ?? protocol) + '//' + (input?.hostname ?? input?.host ?? 'localhost') + (input?.port ? ':' + input.port : '') + (input?.path ?? '/'));
  } catch { return; }
  if (!origins.has(url.origin)) return;
  appendFileSync(trace, JSON.stringify({ channel, url: url.href }) + '\\n');
  throw new Error('MIGRATION_SMOKE_OLD_TARGET_FORBIDDEN');
}
const fetch = globalThis.fetch;
globalThis.fetch = function(input, options) { deny(input, 'http:', 'engine-fetch'); return fetch.call(this, input, options); };
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function(input, ...rest) { deny(input, protocol, 'engine-' + protocol + method); return original.call(this, input, ...rest); };
  }
}
syncBuiltinESMExports();
`);
  return path;
}

async function launch(root, origins, label) {
  const guard = writeNetworkGuard(root, origins);
  const port = await freePort(new Set(origins.map(origin => new URL(origin).port)));
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, 'src/engine-server.mjs', String(port)], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_CONSOLE_DIR: join(REPO, 'console', 'dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: TOKEN, HEIMDALL_LLM: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, root, base: `http://127.0.0.1:${port}`, label, log: '' };
  children.push(record);
  child.stdout.on('data', chunk => { record.log += chunk; });
  child.stderr.on('data', chunk => { record.log += chunk; });
  active = record;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Engine exited: ${record.log}`);
    return (await fetch(record.base, { signal: AbortSignal.timeout(2500) })).ok;
  }, label + ' ready');
  await assertIdle(record);
  return record;
}

async function assertIdle(record) {
  const response = await fetch(record.base + '/api/status', { headers: HEADERS, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.acceptance, null, 'Migration and catalog reads must not start an acceptance worker.');
}

async function api(path, body, expectedStatus = 200, expectedCode) {
  const response = await fetch(active.base + '/api/acceptance/' + path, {
    headers: HEADERS, signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expectedStatus, path + ': ' + JSON.stringify(data));
  if (expectedCode) assert.equal(data.code, expectedCode);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const root of tempRoots) assert.ok(!JSON.stringify(data).includes(root), 'API must not leak disposable root paths.');
  apiCases.push({ scenario: active.label, method: body === undefined ? 'GET' : 'POST', path, status: response.status, ...(expectedCode ? { code: data.code } : {}) });
  return data;
}

function verifyMigration(catalog, original, originalBytes) {
  assert.equal(catalog.schemaVersion, 2);
  assert.notEqual(catalog.generationId, original.generationId);
  assert.match(catalog.generationId, /^ag-[a-f0-9-]{36}$/);
  assert.equal(catalog.revision, original.revision + 1);
  for (const field of ['projects', 'releases', 'runBindings']) assert.deepEqual(catalog[field], original[field], field + ' preserved exactly');
  assert.deepEqual(catalog.events.slice(0, original.events.length), original.events, 'B1 event prefix preserved exactly');
  assert.equal(catalog.events.length, original.events.length + 1);
  for (const field of ['candidates', 'approvals', 'selections']) assert.deepEqual(catalog[field], {}, field + ' remains empty');
  const migrations = Object.values(catalog.migrations);
  assert.equal(migrations.length, 1);
  const migration = migrations[0], event = catalog.events.at(-1);
  assert.equal(migration.fromSchemaVersion, 1);
  assert.equal(migration.toSchemaVersion, 2);
  assert.equal(migration.fromGenerationId, original.generationId);
  assert.equal(migration.fromRevision, original.revision);
  assert.equal(migration.sourceHeadSha256, digest(originalBytes));
  assert.equal(migration.sourcePreviousSha256, null, 'Committed B1 fixture deliberately has no previous file.');
  assert.equal(event.kind, 'catalog-migrated');
  assert.equal(event.entityId, migration.id);
  assert.equal(event.entityDigest, hashAcceptanceValue(migration));
  assert.equal(event.revision, original.revision + 1);
  assert.equal(Object.hasOwn(event, 'projectId'), false);
  return migration;
}

async function browserContext(record, origins) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(token => localStorage.setItem('heimdall-token', token), TOKEN);
  await context.route('**/*', async route => {
    const request = route.request();
    if (origins.includes(new URL(request.url()).origin)) {
      targetAttempts.push({ scenario: record.label, channel: 'browser-route', method: request.method(), url: request.url() });
      return route.abort('blockedbyclient');
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', problem => errors.push({ scenario: record.label, kind: 'pageerror', message: problem.message }));
  page.on('console', message => {
    if (message.type() === 'error') errors.push({ scenario: record.label, kind: 'console-error', message: message.text() });
  });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/acceptance/runs') {
      errors.push({ scenario: record.label, kind: 'unexpected-worker-request', message: 'Browser tried to start an acceptance run.' });
    }
  });
  await page.goto(record.base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Heimdall/i);
  await page.getByRole('button', { name: '项目验收', exact: true }).click();
  const panel = page.getByTestId('acceptance-catalog');
  await panel.getByTestId('catalog-toggle').click();
  return { context, page, panel };
}

async function captureLayout(page, panel, size, name) {
  await page.setViewportSize(size);
  await panel.getByTestId('catalog-toggle').scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="acceptance-catalog"]');
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      catalogWidth: panel.clientWidth, catalogScrollWidth: panel.scrollWidth,
      workbenchWidth: document.querySelector('[data-testid="acceptance-workbench"]').scrollWidth };
  });
  assert.ok(layout.documentWidth <= size.width + 1, 'Document horizontal overflow: ' + JSON.stringify(layout));
  assert.ok(layout.catalogScrollWidth <= layout.catalogWidth + 1, 'Catalog horizontal overflow: ' + JSON.stringify(layout));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  layouts.push({ scenario: active.label, screen: name, ...size, ...layout });
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });
}

try {
  mkdirSync(OUT, { recursive: true });
  assert.deepEqual(readdirSync(OUT), [], 'Use a fresh output directory; never overwrite earlier migration evidence.');
  outputReady = true;
  assert.ok(existsSync(join(REPO, 'console', 'dist', 'index.html')), 'Build the console before running this smoke.');
  const inputBytes = readFileSync(join(FIXTURE, 'catalog-storage.json'));
  const original = JSON.parse(inputBytes.toString('utf8'));
  const inputRuns = treeDigests(join(FIXTURE, 'run-evidence'));
  assert.equal(original.schemaVersion, 1);
  assert.equal(original.revision, 12);
  assert.equal(Object.keys(inputRuns).length, 18);
  const runIds = readdirSync(join(FIXTURE, 'run-evidence')).sort();
  assert.equal(runIds.length, 3);
  const manifests = runIds.map(id => jsonFile(join(FIXTURE, 'run-evidence', id, 'manifest.json')));
  const failed = manifests.find(run => run.gate === 'failed');
  assert.ok(failed, 'Real B1 fixture retains its failed run.');
  const failedBinding = original.runBindings[failed.runId];
  assert.ok(failedBinding, 'The real failed run has its original B1 binding.');
  const unbound = manifests.find(run => !original.runBindings[run.runId]);
  assert.ok(unbound, 'Real B1 fixture has an unbound completed run for post-migration B1 writes.');
  const origins = [...new Set(manifests.flatMap(run => [run.baselineUrl, run.targetUrl].filter(Boolean).map(url => new URL(url).origin)))];
  save('fixture-provenance.json', { sourceCommit: '8353595', evidenceLevel: 'committed-b1-real-run-fixture', fixture: FIXTURE_RELATIVE,
    catalogSha256: digest(inputBytes), runFileCount: 18, runIds, runFileDigests: inputRuns,
    originalSchemaVersion: original.schemaVersion, originalGenerationId: original.generationId, originalRevision: original.revision,
    originalGates: Object.fromEntries(manifests.map(run => [run.runId, run.gate])), oldFixtureOrigins: origins });
  save('catalog-v1-input.json', inputBytes.toString('utf8'));
  checks.committedB1FixtureHasThreeRealRunsAnd18Files = true;

  const dataRoot = createDataRoot();
  assert.deepEqual(copiedRunDigests(dataRoot), inputRuns);
  await launch(dataRoot, origins, 'migration-initial');
  const catalogPath = join(dataRoot, 'acceptance', 'catalog.json');
  const migratedBytes = readFileSync(catalogPath), migrated = JSON.parse(migratedBytes.toString('utf8'));
  const migration = verifyMigration(migrated, original, inputBytes);
  const preimageName = `catalog.v1.${migration.sourceHeadSha256}.json`;
  const preimagePath = join(dataRoot, 'acceptance', preimageName);
  assert.deepEqual(readFileSync(preimagePath), inputBytes, 'Archived B1 preimage preserves exact input bytes.');
  save('migration-preimage.json', { file: preimageName, expectedSha256: digest(inputBytes), actualSha256: digest(readFileSync(preimagePath)), exactBytesEqual: true });
  save('catalog-after-migration.json', migrated);
  checks.schema2GenerationRevisionAndHistoryPrefix = true;
  checks.exactB1PreimageBytesArchived = true;
  let listed = await api('projects');
  assert.equal(listed.schemaVersion, 2);
  assert.equal(listed.generationId, migrated.generationId);
  assert.equal(listed.revision, migrated.revision);
  assert.equal((await api(`runs/${failed.runId}/report`)).gate, 'failed');
  await api('projects', { ...version(original), name: '旧B1 CAS绝不能提交' }, 409, 'STALE_REVISION');
  await api('projects', { expectedGenerationId: original.generationId, expectedRevision: migrated.revision,
    name: '旧generation不能借新revision提交' }, 409, 'STALE_REVISION');
  assert.deepEqual(readFileSync(catalogPath), migratedBytes, 'Old-generation CAS does not mutate the migrated catalog.');
  checks.oldB1CasGets409AndFailedGatePreserved = true;
  for (let index = 1; index <= 2; index++) {
    await stop(active);
    await launch(dataRoot, origins, 'migration-restart-' + index);
    assert.deepEqual(readFileSync(catalogPath), migratedBytes, 'Restart does not migrate twice or rewrite schema2 bytes.');
    assert.deepEqual(readFileSync(preimagePath), inputBytes);
    assert.deepEqual(copiedRunDigests(dataRoot), inputRuns);
    listed = await api('projects');
    assert.equal(listed.generationId, migrated.generationId);
    assert.equal(listed.revision, migrated.revision);
    save(`catalog-after-restart-${index}.json`, jsonFile(catalogPath));
  }
  checks.twoRestartsAreByteIdempotent = true;

  const newProject = (await api('projects', { ...version(listed), name: '迁移后B1组织写入' }, 201)).project;
  listed = await api('projects');
  const newRelease = (await api(`projects/${newProject.id}/releases`, { ...version(listed), label: '迁移后版本', targetUrl: unbound.targetUrl, buildRef: 'migration-smoke-declared-build' }, 201)).release;
  listed = await api('projects');
  await api(`projects/${newProject.id}/run-bindings`, { ...version(listed), runId: unbound.runId, releaseId: newRelease.id }, 201);
  const written = jsonFile(catalogPath);
  assert.equal(written.revision, migrated.revision + 3);
  assert.equal(written.generationId, migrated.generationId);
  for (const field of ['candidates', 'approvals', 'selections']) assert.deepEqual(written[field], {});
  assert.deepEqual(written.events.slice(0, migrated.events.length), migrated.events);
  assert.deepEqual(written.migrations, migrated.migrations);
  for (const field of ['projects', 'releases', 'runBindings']) for (const [key, entity] of Object.entries(original[field])) assert.deepEqual(written[field][key], entity);
  save('catalog-after-b1-writes.json', written);
  checks.newB1ProjectReleaseBindingRemainWritable = true;

  browser = await chromium.launch({ headless: true });
  const view = await browserContext(active, origins);
  await view.panel.locator('[name="catalog-project"]').selectOption(failedBinding.projectId);
  await view.panel.locator(`[data-binding-run="${failed.runId}"]`).waitFor();
  for (const release of Object.values(original.releases).filter(item => item.projectId === failedBinding.projectId)) await view.panel.locator(`[data-release-id="${release.id}"]`).waitFor();
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await captureLayout(view.page, view.panel, size, `migration-catalog-${size.width}`);
    await view.panel.locator(`[data-binding-run="${failed.runId}"]`).scrollIntoViewIfNeeded();
    await view.page.screenshot({ path: join(OUT, `migration-binding-${size.width}.png`), fullPage: false });
    await view.panel.locator(`[data-testid="catalog-open-run"][data-run-id="${failed.runId}"]`).click();
    await waitFor(async () => (await view.page.locator('.aw-report-head').innerText()).includes(failed.name), 'original failed report visible');
    assert.match(await view.page.getByTestId('acceptance-gate').innerText(), /发现缺陷/);
    await view.page.getByTestId('acceptance-gate').scrollIntoViewIfNeeded();
    const reportLayout = await view.page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth }));
    assert.ok(reportLayout.documentWidth <= size.width + 1, 'Failed report fits viewport.');
    layouts.push({ scenario: active.label, screen: `migration-failed-report-${size.width}`, ...size, ...reportLayout });
    await view.page.screenshot({ path: join(OUT, `migration-failed-report-${size.width}.png`), fullPage: false });
    await view.panel.getByTestId('catalog-toggle').click();
    await view.panel.locator(`[data-binding-run="${failed.runId}"]`).waitFor();
  }
  await view.panel.locator('[name="catalog-project"]').selectOption(newProject.id);
  await view.panel.locator(`[data-binding-run="${unbound.runId}"]`).waitFor();
  await view.panel.locator(`[data-release-id="${newRelease.id}"]`).waitFor();
  checks.realConsoleShowsMigratedAndNewB1Organization = true;
  checks.desktopAndMobileOriginalFailedReportVisible = true;
  await view.context.close();
  await assertIdle(active);
  assert.deepEqual(copiedRunDigests(dataRoot), inputRuns);
  assert.deepEqual(readFileSync(preimagePath), inputBytes);
  await stop(active);

  // Missing source is a separate copy, not mutation of the 18-file main case.
  const missingRoot = createDataRoot(failed.runId);
  const expectedMissingRuns = Object.fromEntries(Object.entries(inputRuns).filter(([file]) => !file.startsWith(failed.runId + '/')));
  await launch(missingRoot, origins, 'isolated-missing-source');
  const missingCatalog = jsonFile(join(missingRoot, 'acceptance', 'catalog.json'));
  verifyMigration(missingCatalog, original, inputBytes);
  const missingDetail = await api(`projects/${failedBinding.projectId}`);
  const missingBinding = missingDetail.runBindings.find(item => item.runId === failed.runId);
  assert.ok(missingBinding);
  assert.equal(missingBinding.source, null);
  assert.equal(missingBinding.diagnostics.evidenceVerified, false);
  assert.ok(missingBinding.diagnostics.issues.some(issue => issue.code === 'SOURCE_UNAVAILABLE'));
  save('missing-source-scenario.json', { scenario: 'isolated-missing-source-copy', omittedRunId: failed.runId,
    mainFixtureRunFilesRemainUntouched: true, copiedRunFileCount: Object.keys(expectedMissingRuns).length,
    binding: missingBinding, catalogGenerationId: missingCatalog.generationId, catalogRevision: missingCatalog.revision });
  const missingView = await browserContext(active, origins);
  await missingView.panel.locator('[name="catalog-project"]').selectOption(failedBinding.projectId);
  const missingRow = missingView.panel.locator(`[data-binding-run="${failed.runId}"]`);
  await missingRow.waitFor();
  assert.match(await missingRow.innerText(), /SOURCE_UNAVAILABLE/);
  await captureLayout(missingView.page, missingView.panel, { width: 390, height: 844 }, 'migration-missing-source-390');
  await missingRow.scrollIntoViewIfNeeded();
  await missingView.page.screenshot({ path: join(OUT, 'migration-missing-source-binding-390.png'), fullPage: false });
  await missingView.context.close();
  assert.deepEqual(copiedRunDigests(missingRoot), expectedMissingRuns);
  await assertIdle(active);
  checks.missingSourceBindingPreservedWithSeparateDiagnostics = true;

  for (const root of tempRoots) {
    const trace = join(root, 'old-target-attempts.jsonl');
    if (existsSync(trace)) for (const line of readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)) targetAttempts.push(JSON.parse(line));
  }
  assert.deepEqual(targetAttempts, [], 'Migration, B1 writes and browsing never request the old fixture targets.');
  assert.deepEqual(errors, [], 'Console has no pageerror, console error or unexpected run creation.');
  assert.deepEqual(treeDigests(join(FIXTURE, 'run-evidence')), inputRuns);
  assert.deepEqual(readFileSync(join(FIXTURE, 'catalog-storage.json')), inputBytes);
  assert.deepEqual(copiedRunDigests(dataRoot), inputRuns);
  checks.zeroTargetRequestsAndNoNewAcceptanceWorker = true;
  checks.originalAndCopiedRunTreesRemainByteIdentical = true;
  save('api-cases.json', apiCases);
  save('run-file-digests.json', { source: inputRuns, mainCopyAfter: copiedRunDigests(dataRoot), missingCopyAfter: copiedRunDigests(missingRoot) });
  save('target-attempts.json', targetAttempts);
  const result = { status: 'passed', evidenceLevel: 'committed-b1-fixture-real-engine-browser-migration',
    sourceCommit: '8353595', fixture: FIXTURE_RELATIVE, checkCount: Object.keys(checks).length, checks,
    originalRevision: original.revision, migratedRevision: migrated.revision, originalGenerationId: original.generationId,
    migratedGenerationId: migrated.generationId, sourceRunFiles: 18, originalFailedRunId: failed.runId,
    restartCount: 2, targetRequests: targetAttempts.length, apiCaseCount: apiCases.length, layouts, errors,
    scope: 'B1 8353595真实运行产物复制→真实引擎schema2迁移→两次重启→旧CAS拒绝→新B1写入→桌面/手机控制台与原失败报告；缺失来源在单独副本验证。只初始化空候选字段，不执行新worker、不批准候选、不宣称托管或冻结执行。' };
  save('migration-checks.json', result);
  console.log(JSON.stringify(result, null, 2));
} catch (problem) {
  if (outputReady) save('failure.json', { status: 'failed', message: problem.message, stack: problem.stack, checks, apiCases, layouts, errors, targetAttempts });
  throw problem;
} finally {
  await browser?.close();
  for (const record of children) {
    await stop(record);
    if (outputReady) save(`engine-${record.label}.log`, record.log);
  }
  for (const root of tempRoots) {
    const actual = realpathSync(root), rel = relative(realpathSync(tmpdir()), actual);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('heimdall-acceptance-catalog-migration-'), 'Cleanup stays in this smoke disposable roots.');
    rmSync(actual, { recursive: true, force: true });
  }
}
