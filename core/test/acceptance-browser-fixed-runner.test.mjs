/** Controlled execution tests: real runner/scoring and captured PNGs, no browser process or network. */
import test, { after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { chromium } from 'playwright';
import { runFixedBrowserAcceptance } from '../src/acceptance/browser-fixed-runner.mjs';
import { fixedBrowserCheckIdentity } from '../src/acceptance/browser-fixed-contract.mjs';
import { canonicalAcceptanceJson } from '../src/acceptance/identity.mjs';
import { resolveAcceptanceRoute } from '../src/acceptance/runner.mjs';
import { browserFixedFixture } from './fixtures/acceptance-browser-fixed.mjs';
import { copy } from './fixtures/acceptance-browser-organized-candidate.mjs';

const OUTPUT = fileURLToPath(new URL('../workspace/_runs/d3-fixed-runner-tests/', import.meta.url));
// 每个用例各建一个随机子目录却从不清理：每跑一次全量测试，真实 core/workspace/_runs/ 下就多几百个文件。
// 跑完整体清掉；要留着排查失败现场，就设 D3_FIXED_RUNNER_KEEP_OUTPUT=1。
afterAll(async () => { if (!process.env.D3_FIXED_RUNNER_KEEP_OUTPUT) await rm(OUTPUT, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); });
async function output() { const dir = join(OUTPUT, randomUUID()); await mkdir(dir, { recursive: true }); return dir; }
function fakeBrowser(t, fixture, options = {}) {
  const visited = [], handlers = new Map(), pending = new Set(); let closes = 0, contexts = 0;
  // A real Playwright driver keeps navigation alive until the browser closes.
  const driver = new MessageChannel(); driver.port1.ref();
  const closeDriver = () => { driver.port1.close(); driver.port2.close(); };
  t.after(closeDriver);
  const browser = {
    version: () => options.browserVersion ?? fixture.contract.fixedBaseline.sourceEnvironment.browserVersion,
    async close() { closes++; closeDriver(); for (const reject of pending) reject(new Error('Browser closed.')); pending.clear(); },
    async newContext({ viewport }) {
      contexts++; let route, point, routePolicy;
      const selected = () => fixture.contract.observations.find(value => value.slot.route === route
        && value.slot.viewport.width === viewport.width && value.slot.viewport.height === viewport.height
        && (value.slot.pointId ?? null) === (point?.id ?? null));
      const side = () => JSON.parse(fixture.sourceFiles.get(selected().evidence.details.file).toString());
      const locator = selector => ({
        first() { return this; },
        async click() { if (options.stepError) throw options.stepError; point = fixture.contract.plan.points.find(value => value.route === route && value.steps.some(step => step.selector === selector)); },
        async fill() {}, async press() {},
        async isVisible() { if (options.assertionError) throw options.assertionError; return true; },
        async getAttribute(attribute) { if (options.assertionError) throw options.assertionError; return side().assertions.find(value => value.selector === selector && value.attribute === attribute)?.actual ?? null; },
        async textContent() { return side().assertions.find(value => value.selector === selector)?.actual ?? ''; },
      });
      const page = {
        on(kind, handler) { handlers.set(kind, handler); },
        locator, setDefaultTimeout() {}, url: () => resolveAcceptanceRoute(fixture.contract.targetUrl, route),
        async goto(url) {
          visited.push(url);
          route = fixture.contract.plan.routes.find(value => resolveAcceptanceRoute(fixture.contract.targetUrl, value) === url);
          assert.ok(route, 'Only target routes are navigated.');
          if (options.onGoto) await options.onGoto(url);
          if (options.businessError) handlers.get('pageerror')?.(new Error(options.businessError));
          if (options.hangNavigation) await new Promise((resolve, reject) => pending.add(reject));
          if (options.blockWrite) await routePolicy({ request: () => ({ method: () => 'POST', url: () => fixture.contract.targetUrl + '/write', resourceType: () => 'fetch' }), abort: async () => {} });
          return { status: () => 200 };
        },
        async waitForTimeout() {},
        async evaluate() {
          if (options.captureError) throw options.captureError;
          const snapshot = copy(side().snapshot); snapshot.url = page.url();
          if (options.wrongStructure && !point) snapshot.headings = ['Changed target heading'];
          return snapshot;
        },
        async screenshot() {
          const file = selected().evidence.screenshot.file;
          return Buffer.from(options.visualRegression ? fixture.material.files.get(file.replace('-baseline.png', '-target.png')) : fixture.sourceFiles.get(file));
        },
      };
      return { setDefaultTimeout() {}, async route(_pattern, handler) { routePolicy = handler; }, async routeWebSocket() {}, async newPage() { return page; }, async close() {} };
    },
  };
  t.mock.method(chromium, 'launch', async () => browser);
  return { visited, closes: () => closes, contexts: () => contexts };
}
const optionsFor = (fixture, outputDir, extra = {}) => ({ runId: `br-${randomUUID()}`, outputDir, sourceFiles: fixture.sourceFiles, ...extra });
const observedStatus = check => check.observedStatus ?? check.status;
const observedVerdict = check => check.observedVerdict ?? check.verdict;
async function assertNoHostDiagnostic(report, dir) {
  const texts = [JSON.stringify(report), ...await Promise.all((await readdir(dir)).filter(file => file.endsWith('.json')).map(file => readFile(join(dir, file), 'utf8')))];
  for (const text of texts) for (const marker of ['C:/private', '/tmp/token', 'HOST_SECRET_']) assert.equal(text.includes(marker), false, `Host diagnostic marker ${marker} leaked.`);
}

test('fixed runner visits only every declared target slot and preserves the selected evidence bytes', async t => {
  const fixture = await browserFixedFixture('target'), dir = await output(), fake = fakeBrowser(t, fixture), events = [];
  // Operation publication can already have copied source evidence. Matching bytes are never overwritten.
  for (const entry of fixture.contract.sourceEvidence) await writeFile(join(dir, entry.file), fixture.sourceFiles.get(entry.sourceFile));
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { onEvent: event => events.push(event) }));
  assert.equal(report.mode, 'browser-fixed'); assert.equal(report.checks.length, 28);
  assert.deepEqual(report.coverage, { planned: 28, completed: 28, capped: false });
  assert.equal(fake.contexts(), 8); assert.equal(fake.visited.length, 8);
  assert.ok(fake.visited.every(value => value.startsWith('https://fixed-target.test/')));
  assert.ok(report.checks.every(check => observedStatus(check) === 'passed'), JSON.stringify(report.checks));
  assert.ok(report.checks.every(check => check.oracle.kind === 'captured-browser-side'));
  assert.deepEqual(report.fixedBaseline, fixture.contract.fixedBaseline);
  assert.deepEqual(report.resolution, { kind: 'observation-only', closesBugs: false });
  assert.ok(events.some(value => value.kind === 'acceptance-completed'));
  assert.equal(fake.closes(), 1);
  for (const entry of fixture.contract.sourceEvidence) assert.deepEqual(await readFile(join(dir, entry.file)), fixture.material.files.get(entry.sourceFile));
  for (const check of report.checks) {
    const slot = { route: check.route, viewport: check.identity.viewport, ...(check.identity.pointId ? { pointId: check.identity.pointId } : {}) };
    assert.deepEqual(check.identity, fixedBrowserCheckIdentity(fixture.contract, report.environment, slot, check.identity.facet));
    assert.ok(check.evidence.baselineScreenshot.startsWith('source-'));
    assert.ok(check.evidence.targetScreenshot.includes('-target.png'));
    assert.notEqual(check.evidence.baselineScreenshot, check.evidence.targetScreenshot);
  }
});

test('fixed runner keeps source-vs-target visual and structure regressions plus conservative environment gating', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); fakeBrowser(t, fixture, { wrongStructure: true, visualRegression: true, browserVersion: 'different-browser-version' });
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir));
  assert.equal(report.environmentComparison.comparable, false);
  assert.ok(report.environmentComparison.differences.some(value => value.field === 'browserVersion'));
  assert.ok(report.checks.filter(value => value.dimension === 'structure').every(value => observedVerdict(value) === 'bug'));
  assert.equal(report.checks.filter(value => value.dimension === 'visual' && observedVerdict(value) === 'bug').length, 2);
  assert.ok(report.checks.every(value => value.status === 'blocked' && value.verdict === 'environment'));
  assert.ok(report.checks.every(value => value.evaluationLimited === true));
});

test('fixed runner retains read-only policy blockers rather than turning their side effects into bugs', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); fakeBrowser(t, fixture, { blockWrite: true });
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir));
  assert.equal(report.safety.blockedRequests, 8);
  assert.equal(report.coverage.planned, 32); assert.equal(report.coverage.completed, 32);
  assert.equal(report.checks.filter(value => value.identity?.facet === 'readonly').length, 4);
  assert.ok(report.checks.every(value => value.verdict !== 'bug'));
  assert.ok(report.checks.filter(value => ['console', 'network', 'readonly', 'behavior'].includes(value.identity?.facet)).every(value => value.status === 'blocked'));
});

test('unreachable targets remain strict JSON environment observations without missing JavaScript values', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); fakeBrowser(t, fixture, { onGoto: () => { throw new Error('Target connection refused.'); } });
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir));
  assert.doesNotThrow(() => canonicalAcceptanceJson(report));
  assert.equal(report.checks.length, 28);
  assert.ok(report.checks.every(check => check.status === 'blocked' && check.verdict === 'environment'));
  assert.ok(report.checks.filter(check => check.dimension === 'behavior').every(check => !Object.hasOwn(check.actual, 'overflow')));
});

test('fixed browser launch failures publish only controlled environment diagnostics without host paths', async t => {
  const fixture = await browserFixedFixture(), dir = await output();
  t.mock.method(chromium, 'launch', async () => { throw Object.assign(new Error('Executable missing at C:/private/HOST_SECRET_browser.exe; profile /tmp/token/HOST_SECRET_profile'), { code: 'HOST_SECRET_untrusted' }); });
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir));
  assert.equal(report.checks.length, 1); assert.equal(report.checks[0].id, 'runner-environment');
  assert.equal(report.checks[0].status, 'blocked'); assert.equal(report.checks[0].verdict, 'environment');
  assert.deepEqual(report.checks[0].actual, { code: 'BROWSER_EXECUTION_ENVIRONMENT', message: 'Browser acceptance could not complete in the current environment.' });
  await assertNoHostDiagnostic(report, dir);
});

test('fixed navigation, capture, step and assertion API failures omit host paths while retaining page evidence', async t => {
  const fixture = await browserFixedFixture(), hostError = new Error('Driver trace C:/private/HOST_SECRET_driver: /tmp/token/HOST_SECRET_session');
  for (const stage of ['navigation', 'capture', 'step', 'assertion']) await t.test(stage, async t => {
    const dir = await output(), options = stage === 'navigation' ? { onGoto: () => { throw hostError; } } : { [stage + 'Error']: hostError };
    const businessError = 'Order total differs from the displayed cart.';
    fakeBrowser(t, fixture, { ...options, ...(stage === 'assertion' ? { businessError } : {}) });
    const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir));
    await assertNoHostDiagnostic(report, dir);
    const details = await Promise.all((await readdir(dir)).filter(file => file.endsWith('-target.json') || /-target\.json$/.test(file)).map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))));
    if (stage === 'navigation' || stage === 'capture') {
      assert.ok(report.checks.every(check => check.status === 'blocked' && check.verdict === 'environment'));
      assert.ok(details.some(detail => detail[stage + 'Error']?.code === `BROWSER_${stage.toUpperCase()}_FAILED`));
    } else {
      const behavior = report.checks.filter(check => check.dimension === 'behavior');
      assert.ok(behavior.length > 0 && behavior.every(check => observedStatus(check) !== 'passed'));
      if (stage === 'step') assert.ok(behavior.every(check => check.actual.stepError?.code === 'BROWSER_STEP_FAILED'));
      else {
        assert.ok(behavior.every(check => check.actual.assertions.every(assertion => assertion.error?.code === 'BROWSER_ASSERTION_UNAVAILABLE')));
        assert.ok(report.checks.some(check => JSON.stringify(check.actual).includes(businessError)));
        assert.ok(details.some(detail => detail.errors.some(error => error.message === businessError)));
      }
    }
  });
});

test('an interrupted partial execution cannot preserve earlier reliable passes or close findings', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); fakeBrowser(t, fixture);
  let interrupted = false;
  const report = await runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { onEvent: event => {
    if (event.kind === 'acceptance-progress' && !interrupted) { interrupted = true; throw new Error('Progress transport unavailable.'); }
  } }));
  assert.equal(interrupted, true);
  assert.equal(report.coverage.planned, 28);
  assert.ok(report.coverage.completed < report.coverage.planned);
  assert.ok(report.checks.some(check => check.id === 'runner-environment'));
  assert.ok(report.checks.every(check => check.status === 'blocked' && check.verdict === 'environment'));
  assert.ok(report.checks.filter(check => check.identity).every(check => check.evaluationLimited === true));
});

test('cancel during target navigation closes the browser and stops later evidence/events', async t => {
  const fixture = await browserFixedFixture(), dir = await output(), controller = new AbortController(), events = [];
  const fake = fakeBrowser(t, fixture, { onGoto: () => controller.abort() });
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { signal: controller.signal, onEvent: event => events.push(event) })), error => error.code === 'BROWSER_EXECUTION_CANCELLED');
  assert.ok(fake.closes() >= 1);
  assert.ok((await readdir(dir)).every(file => file.startsWith('source-')));
  assert.equal(events.some(value => value.kind === 'acceptance-completed'), false);
});

test('owner loss actively closes pending navigation without waiting for its browser timeout', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); let active = true;
  let timer;
  const fake = fakeBrowser(t, fixture, { hangNavigation: true, onGoto: () => { timer = setTimeout(() => { active = false; }, 30); } });
  const started = Date.now();
  try {
    await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { assertActive: () => {
      if (!active) throw Object.assign(new Error('Owner fence changed.'), { code: 'CATALOG_UNAVAILABLE' });
    } })), error => error.code === 'CATALOG_UNAVAILABLE');
  } finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 1500); assert.ok(fake.closes() >= 1);
  assert.ok((await readdir(dir)).every(file => file.startsWith('source-')));
});

test('deadline expires during navigation and cannot publish later evidence', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); let elapsed = 0;
  const now = Date.now.bind(Date); t.mock.method(Date, 'now', () => now() + elapsed);
  const fake = fakeBrowser(t, fixture, { onGoto: () => { elapsed = 300_001; } });
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir)), error => error.code === 'BROWSER_EXECUTION_DEADLINE');
  assert.ok(fake.closes() >= 1); assert.ok((await readdir(dir)).every(file => file.startsWith('source-')));
});

test('uncompiled input, changed evidence, wrong run identity and pre-cancel cannot launch a browser', async t => {
  const fixture = await browserFixedFixture(), dir = await output(); let launches = 0;
  t.mock.method(chromium, 'launch', async () => { launches++; throw new Error('Unexpected launch'); });
  await assert.rejects(runFixedBrowserAcceptance(copy(fixture.contract), optionsFor(fixture, dir)), error => error.code === 'BASELINE_CHANGED');
  const badFiles = new Map(fixture.sourceFiles), file = badFiles.keys().next().value; badFiles.set(file, Buffer.alloc(badFiles.get(file).length));
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { sourceFiles: badFiles })), error => error.code === 'BASELINE_CHANGED');
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { runId: 'ac-wrong' })), /br-UUID/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir, { signal: controller.signal })), error => error.code === 'BROWSER_EXECUTION_CANCELLED');
  await writeFile(join(dir, fixture.contract.sourceEvidence[0].file), Buffer.from('changed source'));
  await assert.rejects(runFixedBrowserAcceptance(fixture.contract, optionsFor(fixture, dir)), error => error.code === 'SOURCE_INTEGRITY_FAILED');
  assert.equal(launches, 0);
});
