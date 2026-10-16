import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { chromium } from 'playwright';

async function fixture(t) {
  let writes = 0;
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) { writes++; response.end('unexpected write'); return; }
    const path = new URL(request.url, 'http://fixture.test').pathname;
    const [, side, name = 'good'] = path.split('/');
    const target = side === 'target';
    if (name === 'http404' && target || name === 'badbaseline') { response.writeHead(404); response.end('missing'); return; }
    if (name === 'missing-resource') { response.writeHead(404); response.end('missing resource'); return; }
    const missingMenu = target && name === 'missing';
    const badExpanded = target && name === 'aria';
    const wrongText = target && name === 'text';
    const consoleError = name === 'shared-console' || target && name === 'console';
    const overflow = target && name === 'overflow';
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><title>Acceptance fixture</title>
      <style>body{margin:0;font-family:Arial;background:#fff;color:#222}main{padding:20px}#menu{display:block}@media(min-width:600px){#menu{display:none}}#dynamic{height:240px;width:100%}</style></head>
      <body><main id="app" ${name === 'full-mask' ? `style="box-sizing:border-box;min-height:100vh;background:${target ? 'red' : 'white'}"` : ''}><h1>${name === 'full-mask' && target ? 'Entirely different target content' : 'Fixture'}</h1>${missingMenu ? '' : '<button id="menu">Menu</button>'}
      <button id="toggle" aria-expanded="false">Toggle details</button><p id="status">${wrongText ? 'Unexpected copy' : 'Ready'}</p>
      <input id="entry" aria-label="Search"><button id="save">Save</button>
      ${overflow ? '<div style="width:1200px">Overflow</div>' : ''}
      ${name === 'dynamic' ? '<div id="dynamic"></div>' : ''}
      ${name === 'long-page' ? `<section style="height:1600px;background:#f5f5f5">Shared content above the fold</section>${target ? '' : '<section style="height:700px;background:#c0275b;color:white">Required content below the first viewport</section>'}` : ''}
      ${name === 'over-budget-height' ? '<section style="height:13000px">Content exceeds the capture height budget</section>' : ''}
      ${name === 'over-budget-pixels' ? '<section style="height:9000px">Content exceeds the capture pixel budget</section>' : ''}
      </main><script>
      document.querySelector('#toggle').onclick=()=>{${badExpanded ? '' : "document.querySelector('#toggle').setAttribute('aria-expanded','true')"}};
      document.querySelector('#save').onclick=()=>fetch('/api/save',{method:'POST',body:'private-user-value'}).catch(()=>{});
      ${consoleError ? "console.error('Fixture runtime error')" : ''};
      ${name === 'shared-network' ? `fetch('/${side}/missing-resource').catch(()=>{})` : ''};
      ${target && name === 'auto-write' ? "fetch('/api/save',{method:'POST'}).catch(()=>console.error('Target POST was blocked by the execution policy'))" : ''};
      ${name === 'dynamic' ? "window.setAcceptanceNoisePhase=phase=>{const element=document.querySelector('#dynamic');element.style.background=['red','green','blue'][phase%3];return getComputedStyle(element).backgroundColor};window.setAcceptanceNoisePhase(0)" : ''};
      </script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const outputDir = await mkdtemp(join(tmpdir(), 'acceptance-runner-test-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { outputDir, origin, writes: () => writes };
}

function planFor(origin, extra = {}) {
  // This budget also covers a cold Chromium launch. Keep the production default
  // rather than imposing a 1.2s startup benchmark on parallel, shared CI runners.
  return normalizeAcceptancePlan({ name: 'Runner verification', mode: 'mirror', baselineUrl: `${origin}/baseline/`, targetUrl: `${origin}/target/`, routes: ['/good'], viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 10_000, settleMs: 100, ...extra });
}

function dynamicCapturePhases(t, phases = [0, 1]) {
  // A three-color 33ms interval repeats every 99ms and can alias the runner's
  // two samples. Drive the real fixture at each real capture so this test
  // proves different pixels, independently of screenshot/CI scheduling.
  const observations = [], launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options), newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage(), screenshot = page.screenshot.bind(page);
        let capture = 0;
        page.screenshot = async options => {
          const path = new URL(page.url()).pathname;
          if (path.endsWith('/dynamic')) {
            assert.ok(capture < phases.length, 'Every dynamic capture has an explicit fixture phase.');
            const phase = phases[capture++];
            const background = await page.evaluate(phase => window.setAcceptanceNoisePhase(phase), phase);
            observations.push({ path, phase, background });
          }
          return screenshot(options);
        };
        return page;
      };
      return context;
    };
    return browser;
  });
  return observations;
}

test('acceptance runner reproduces missing controls, wrong ARIA, text, HTTP and runtime regressions', { timeout: 60_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const events = [];
  const plan = planFor(origin, {
    routes: ['/good', '/missing', '/aria', '/text', '/http404', '/console', '/overflow'],
    points: [
      { id: 'menu', title: 'Mobile menu visible', route: '/missing', severity: 'high', assertions: [{ kind: 'visible', selector: '#menu' }] },
      { id: 'expanded', title: 'Toggle exposes expanded state', route: '/aria', steps: [{ action: 'click', selector: '#toggle' }], assertions: [{ kind: 'attribute', selector: '#toggle', attribute: 'aria-expanded', equals: 'true' }] },
      { id: 'copy', title: 'Status copy', route: '/text', assertions: [{ kind: 'text', selector: '#status', equals: 'Ready' }] },
    ],
  });
  const report = await runAcceptance(plan, { runId: 'runner-regressions', outputDir, onEvent: event => events.push(event) });
  const byRoute = route => report.checks.filter(check => check.route === route);
  assert.equal(report.checks.length, 45, JSON.stringify({ coverage: report.coverage,
    runnerErrors: report.checks.filter(check => check.id === 'runner-environment').map(check => check.actual) }));
  assert.equal(report.coverage.planned, 45);
  assert.equal(report.coverage.completed, 45);
  assert.deepEqual(report.environment, { platform: process.platform, arch: process.arch, nodeVersion: process.version,
    browser: 'chromium', browserVersion: report.environment.browserVersion, playwrightVersion: report.environment.playwrightVersion,
    locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' });
  assert.match(report.environment.browserVersion, /^\d+\./);
  assert.match(report.environment.playwrightVersion, /^\d+\./);
  assert.ok(report.checks.every(check => check.identity?.kind === 'browser' && check.identity.version === 1));
  assert.ok(report.checks.every(check => check.identity.viewport.width === 375 && check.identity.viewport.height === 812));
  assert.equal(report.checks.find(check => check.dimension === 'behavior').identity.pointId, 'menu');
  assert.ok(byRoute('/good').every(check => check.status === 'passed'), JSON.stringify(byRoute('/good')));
  for (const route of ['/missing', '/aria', '/text']) assert.ok(byRoute(route).some(check => check.dimension === 'behavior' && check.verdict === 'bug'), `missing behavior bug: ${route}`);
  assert.ok(byRoute('/http404').some(check => check.id.endsWith('navigation') && check.verdict === 'bug'));
  assert.ok(byRoute('/console').some(check => check.id.endsWith('console') && check.verdict === 'bug'));
  assert.ok(byRoute('/overflow').some(check => check.id.endsWith('overflow') && check.verdict === 'bug'));
  for (const route of ['/console', '/overflow', '/http404']) assert.ok(byRoute(route).filter(check => ['visual', 'structure'].includes(check.dimension)).every(check => check.status === 'blocked'));
  const visual = byRoute('/good').find(check => check.dimension === 'visual');
  assert.equal(visual.score, 1);
  const baselineImage = await readFile(join(outputDir, visual.evidence.baselineScreenshot));
  assert.ok(baselineImage.length > 100);
  const { hashAcceptanceValue } = await import('../src/acceptance/identity.mjs');
  assert.equal(visual.identity.oracleKey, hashAcceptanceValue({ kind: 'runtime', source: plan.baselineUrl,
    baselineScreenshotSha256: createHash('sha256').update(baselineImage).digest('hex') }));
  assert.ok((await readdir(outputDir)).some(file => file.endsWith('-diff.png')));
  const serialized = JSON.parse(await readFile(join(outputDir, visual.evidence.baselineDetails), 'utf8'));
  assert.equal(serialized.snapshot.title, 'Acceptance fixture');
  assert.equal(serialized.image, undefined);
  assert.ok(events.some(event => event.kind === 'acceptance-completed'));
  assert.ok(events.every(event => typeof event.message === 'string' && !Object.hasOwn(event, 'check')));
  assert.ok(events.some(event => event.kind === 'acceptance-check' && event.completed > 0 && event.total === report.coverage.planned));
  assert.ok(Object.values(visual.evidence).every(value => value === null || typeof value === 'string'));
});

test('browser identities survive reordered routes, points, renamed viewports and a different target entry', { timeout: 25_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const points = [
    { id: 'copy', title: 'Original title', route: '/text', assertions: [{ kind: 'text', selector: '#status', equals: 'Ready' }] },
    { id: 'menu', title: 'Visible menu', route: '/good', assertions: [{ kind: 'visible', selector: '#menu' }] },
  ];
  const first = await runAcceptance(planFor(origin, { routes: ['/good', '/text'], points }), { outputDir: join(outputDir, 'first') });
  const second = await runAcceptance(planFor(origin, { name: 'Renamed run', routes: ['/text', '/good'],
    targetUrl: `${origin}/target/?version=next`, viewports: [{ name: 'phone-renamed', width: 375, height: 812 }],
    points: [...points].reverse().map(point => ({ ...point, title: 'Changed display title', severity: 'low' })),
  }), { outputDir: join(outputDir, 'second') });
  assert.equal(first.checks.length, second.checks.length);
  for (const check of first.checks) {
    const other = second.checks.find(item => item.identity.contextKey === check.identity.contextKey);
    assert.ok(other, `${check.route} ${check.identity.facet} ${check.identity.pointId ?? ''}`);
    assert.deepEqual(other.identity, check.identity);
    assert.notEqual(other.id, check.id);
  }
});

test('acceptance runner refuses to attribute baseline failures, shared errors, dynamic noise and blocked writes', { timeout: 45_000 }, async t => {
  const { origin, outputDir, writes } = await fixture(t);
  const captures = dynamicCapturePhases(t);
  const plan = planFor(origin, {
    routes: ['/badbaseline', '/shared-console', '/shared-network', '/dynamic', '/good', '/auto-write'],
    points: [
      { id: 'baseline-invalid', route: '/good', title: 'Invalid approved oracle', assertions: [{ kind: 'text', selector: '#status', equals: 'No such text' }] },
      { id: 'write-blocked', route: '/good', title: 'Read-only POST guard', steps: [{ action: 'click', selector: '#save' }], assertions: [{ kind: 'visible', selector: '#save' }] },
      { id: 'input', route: '/good', title: 'Fill and keyboard input', steps: [{ action: 'fill', selector: '#entry', value: 'search term' }, { action: 'press', selector: '#entry', value: 'Tab' }], assertions: [{ kind: 'visible', selector: '#entry' }] },
    ],
  });
  const report = await runAcceptance(plan, { outputDir });
  const byRoute = route => report.checks.filter(check => check.route === route);
  for (const route of ['/badbaseline', '/shared-console', '/shared-network', '/dynamic', '/auto-write']) assert.ok(byRoute(route).every(check => check.verdict !== 'bug'), `false target bug: ${route}`);
  assert.ok(byRoute('/badbaseline').some(check => check.verdict === 'baseline_failed'));
  assert.ok(byRoute('/shared-console').some(check => check.verdict === 'baseline_failed' && check.status === 'needs_review'));
  assert.ok(byRoute('/shared-network').some(check => check.verdict === 'baseline_failed' && check.status === 'needs_review'));
  const dynamic = byRoute('/dynamic').find(check => check.dimension === 'visual');
  assert.deepEqual(captures.map(capture => capture.phase), [0, 1, 0, 1]);
  assert.deepEqual(captures.map(capture => capture.background), ['rgb(255, 0, 0)', 'rgb(0, 128, 0)', 'rgb(255, 0, 0)', 'rgb(0, 128, 0)']);
  assert.equal(dynamic.actual.score, 1, 'Baseline and target start in the same phase.');
  assert.ok(dynamic.actual.baselineStability < dynamic.expected.stabilityMinimum);
  assert.ok(dynamic.actual.targetStability < dynamic.expected.stabilityMinimum);
  assert.equal(dynamic.status, 'needs_review');
  assert.equal(dynamic.verdict, 'needs_review');
  assert.equal(report.checks.find(check => check.title === 'Invalid approved oracle').verdict, 'baseline_failed');
  assert.equal(report.checks.find(check => check.title === 'Read-only POST guard').verdict, 'environment');
  assert.equal(report.checks.find(check => check.title === 'Fill and keyboard input').status, 'passed');
  assert.equal(writes(), 0);
  assert.equal(report.safety.blockedRequests, 3);
  for (const facet of ['console', 'network']) {
    const check = byRoute('/auto-write').find(item => item.id.endsWith(`-${facet}`));
    assert.equal(check.status, 'blocked');
    assert.equal(check.verdict, 'environment');
    assert.equal(check.actual.policyAffected, true);
  }
  assert.equal(report.coverage.completed, report.coverage.planned);
});

test('dynamic masks permit deterministic comparison, and unreachable targets stay environment blockers', { timeout: 25_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const captures = dynamicCapturePhases(t);
  const masked = await runAcceptance(planFor(origin, { routes: ['/dynamic'], normalization: { maskSelectors: ['#dynamic'] } }), { outputDir });
  const maskedVisual = masked.checks.find(check => check.dimension === 'visual');
  assert.equal(maskedVisual.status, 'passed');
  assert.deepEqual(captures.map(capture => capture.phase), [0, 1, 0, 1]);
  assert.equal(maskedVisual.actual.baselineStability, 1);
  assert.equal(maskedVisual.actual.targetStability, 1);
  assert.ok(maskedVisual.actual.maskCoverage.baseline.maskedRatio > 0);
  assert.ok(maskedVisual.actual.maskCoverage.baseline.maskedRatio < 0.8);
  const unreachable = await runAcceptance(planFor(origin, { targetUrl: 'http://127.0.0.1:1/', routes: ['/good'] }), { outputDir: join(outputDir, 'unreachable') });
  assert.ok(unreachable.checks.every(check => check.verdict !== 'bug'));
  assert.ok(unreachable.checks.some(check => check.status === 'blocked' && check.verdict === 'environment'));
});

test('same-phase periodic samples remain a bounded observation rather than proof of all-time stability', { timeout: 15_000 }, async t => {
  const { origin, outputDir } = await fixture(t), captures = dynamicCapturePhases(t, [0, 3]);
  const report = await runAcceptance(planFor(origin, { routes: ['/dynamic'] }), { outputDir });
  const visual = report.checks.find(check => check.dimension === 'visual');
  assert.deepEqual(captures.map(capture => capture.phase), [0, 3, 0, 3]);
  assert.ok(captures.every(capture => capture.background === 'rgb(255, 0, 0)'));
  assert.equal(visual.actual.baselineStability, 1);
  assert.equal(visual.actual.targetStability, 1);
  assert.equal(visual.status, 'passed');
  assert.match(report.scope, /有界观察窗口/);
});

test('overlapping full-screen masks cannot produce false green acceptance', { timeout: 15_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const report = await runAcceptance(planFor(origin, { routes: ['/full-mask'], normalization: { maskSelectors: ['#app', 'main'] } }), { outputDir });
  const protectedChecks = report.checks.filter(check => ['visual', 'structure'].includes(check.dimension));
  assert.equal(protectedChecks.length, 2);
  assert.ok(protectedChecks.every(check => check.status === 'needs_review' && check.verdict === 'needs_review'));
  for (const check of protectedChecks) {
    assert.equal(check.actual.maskCoverage.baseline.maskedRatio, 1);
    assert.equal(check.actual.maskCoverage.target.maskedRatio, 1);
    assert.equal(check.actual.maskCoverage.baseline.effectiveAreaPx, 0);
    assert.equal(check.actual.maskCoverage.target.effectiveAreaPx, 0);
  }
  assert.equal(report.coverage.completed, report.coverage.planned);
});

test('bounded full-page capture detects missing content below the first viewport', { timeout: 20_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const report = await runAcceptance(planFor(origin, { routes: ['/long-page'] }), { outputDir });
  const visual = report.checks.find(check => check.dimension === 'visual');
  assert.equal(visual.status, 'failed');
  assert.equal(visual.verdict, 'bug');
  assert.equal(visual.actual.capture.baseline.captureScope, 'full-page');
  assert.equal(visual.actual.capture.target.captureScope, 'full-page');
  assert.equal(visual.actual.capture.baseline.captureLimited, false);
  assert.ok(visual.actual.capture.baseline.documentSize.height > 812);
  assert.ok(visual.actual.capture.baseline.documentSize.height > visual.actual.capture.target.documentSize.height + 600);
  const first = await readFile(join(outputDir, visual.evidence.baselineScreenshot));
  const repeated = await readFile(join(outputDir, visual.evidence.baselineRepeat));
  assert.equal(first.readUInt32BE(20), repeated.readUInt32BE(20));
  assert.equal(first.readUInt32BE(20), visual.actual.capture.baseline.documentSize.height);
  const details = JSON.parse(await readFile(join(outputDir, visual.evidence.baselineDetails), 'utf8'));
  assert.equal(details.captureScope, 'full-page');
  assert.equal(details.snapshot.captureScope, 'full-page');
});

test('documents beyond height or pixel budgets retain viewport evidence and require review', { timeout: 20_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const report = await runAcceptance(planFor(origin, { routes: ['/over-budget-height', '/over-budget-pixels'], viewports: [{ name: 'desktop', width: 1440, height: 900 }] }), { outputDir });
  const visuals = report.checks.filter(check => check.dimension === 'visual');
  assert.equal(visuals.length, 2);
  for (const visual of visuals) {
    assert.equal(visual.status, 'needs_review');
    assert.equal(visual.verdict, 'needs_review');
    assert.equal(visual.actual.eligible, false);
    for (const side of ['baseline', 'target']) {
      assert.equal(visual.actual.capture[side].captureLimited, true);
      assert.equal(visual.actual.capture[side].captureScope, 'viewport-only');
    }
    const first = await readFile(join(outputDir, visual.evidence.baselineScreenshot));
    const repeated = await readFile(join(outputDir, visual.evidence.baselineRepeat));
    assert.equal(first.readUInt32BE(20), 900);
    assert.equal(repeated.readUInt32BE(20), 900);
  }
  assert.match(report.scope, /12,000,000/);
  assert.equal(report.coverage.completed, report.coverage.planned);
});

test('capture failures on both sides never become passing acceptance results', { timeout: 15_000 }, async t => {
  const { origin, outputDir } = await fixture(t);
  const launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async options => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.screenshot = async () => { throw new Error('Fixture screenshot capture failed'); };
        return page;
      };
      return context;
    };
    return browser;
  });
  const report = await runAcceptance(planFor(origin), { outputDir });
  assert.equal(report.checks.length, 6);
  assert.ok(report.checks.every(check => check.status === 'blocked'));
  assert.ok(report.checks.every(check => check.verdict !== 'bug'));
  assert.equal(report.checks.find(check => check.dimension === 'visual').score, undefined);
});
