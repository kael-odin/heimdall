import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAcceptanceFixture } from './fixtures/acceptance-site.mjs';
import { exploreAcceptanceBaseline, relativeTo } from '../src/acceptance/explore.mjs';

let fixture;
before(async () => { fixture = await startAcceptanceFixture(); });
after(async () => { await fixture?.close(); });

const desktop = [{ name: 'desktop', width: 1280, height: 800 }];
const mobile = [{ name: 'mobile', width: 390, height: 844 }];

test('exploration input is validated before any browser work', async () => {
  await assert.rejects(() => exploreAcceptanceBaseline({ baselineUrl: 'file:///etc/passwd' }), /must be HTTP/);
  await assert.rejects(() => exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl + '/identical', routes: ['relative'] }), /route/);
  await assert.rejects(() => exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl + '/identical', viewports: [{ name: 'desktop', width: 100, height: 800 }] }), /viewport width/);
  await assert.rejects(() => exploreAcceptanceBaseline(null), /must be an object/);
});

test('relative paths drop the entry so one assertion fits baseline and target', () => {
  assert.equal(relativeTo('http://h/baseline', 'http://h/baseline/details'), '/details');
  assert.equal(relativeTo('http://h/baseline', 'http://h/baseline'), '/');
  assert.equal(relativeTo('http://h/baseline', 'http://h/target/details'), null);
  assert.equal(relativeTo('http://h/baseline', 'http://other/details'), null);
});

test('menu toggle yields a state assertion that is false before the click and true after it', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: desktop });
  assert.equal(result.routes[0].status, 'explored');
  const toggle = result.points.find(point => point.steps?.[0]?.selector === '#menu-toggle');
  assert.ok(toggle, 'menu toggle point');
  assert.deepEqual(toggle.steps, [{ action: 'click', selector: '#menu-toggle' }]);
  assert.equal(toggle.severity, 'high');
  assert(toggle.assertions.some(a => a.kind === 'attribute' && a.selector === '#menu-toggle'
    && a.attribute === 'aria-expanded' && a.equals === 'true'), 'aria-expanded assertion');
  assert(toggle.assertions.some(a => a.kind === 'visible' && a.selector === '#menu'), 'menu becomes visible');
  assert(toggle.assertions.length <= 4);
});

test('link click yields an entry-relative url assertion', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: desktop });
  const link = result.points.find(point => point.steps?.[0]?.selector === '#details-link');
  assert.ok(link, 'details link point');
  assert(link.assertions.some(a => a.kind === 'url' && typeof a.contains === 'string' && a.contains.startsWith('/')), 'url assertion');
  for (const assertion of link.assertions) {
    if (assertion.selector) assert(!/ > |:nth-of-type\(/.test(assertion.selector), 'only stable selectors are proposed');
  }
});

test('content point covers short text the structure check does not compare', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: desktop });
  const content = result.points.find(point => !point.steps?.length);
  assert.ok(content, 'content point');
  assert(content.assertions.some(a => a.selector === '#quota' && a.kind === 'text'), 'quota text');
  assert(content.assertions.some(a => a.selector === '#quota' && a.kind === 'visible'), 'quota visible');
});

test('every proposed point is stable on the same baseline at the planned viewports', async () => {
  // Mobile hides nothing on the baseline; the same assertions must hold at 390px too.
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: [...desktop, ...mobile] });
  const toggle = result.points.find(point => point.steps?.[0]?.selector === '#menu-toggle');
  assert.ok(toggle, 'toggle survives multi-viewport replay');
  const quota = result.points.find(point => point.assertions.some(a => a.selector === '#quota' && a.kind === 'text'));
  assert.ok(quota, 'quota text holds at both viewports');
});

test('an unhealthy baseline is reported instead of producing points', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/baseline-error'], viewports: desktop });
  assert.equal(result.routes[0].status, 'baseline-unhealthy');
  assert.equal(result.points.length, 0);
  assert(result.routes[0].healthIssues.errors.length > 0);
});

test('a page that does not load is reported as navigation-failed', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: 'http://127.0.0.1:1', routes: ['/'], timeoutMs: 1000, budgetMs: 20_000 });
  assert.equal(result.routes[0].status, 'navigation-failed');
  assert.equal(result.points.length, 0);
});

test('points already declared in a plan are not proposed twice', async () => {
  const plan = { schemaVersion: 1, name: 'Existing', mode: 'mirror', baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl,
    routes: ['/identical'], viewports: [{ name: 'desktop', width: 1280, height: 800 }],
    points: [{ id: 'existing-toggle', title: 'Existing toggle', route: '/identical', severity: 'high',
      steps: [{ action: 'click', selector: '#menu-toggle' }],
      assertions: [{ kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
        { kind: 'visible', selector: '#menu' }] }] };
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: desktop, plan });
  assert.equal(result.plan.points, 1);
  const duplicate = result.routes[0].skipped['already-planned'] ?? 0;
  assert.ok(duplicate > 0, 'the identical proposal was counted as already planned');
  assert.equal(result.points.find(point => point.steps?.[0]?.selector === '#menu-toggle' && point.assertions.length === 2 && point.assertions[0].kind === 'attribute'), undefined);
});

test('the budget stops exploration without proposing partial work as healthy', async () => {
  const result = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: ['/identical'], viewports: desktop, budgetMs: 15_000 });
  assert.ok(result.summary.durationMs >= 0);
  assert(result.points.every(point => Array.isArray(point.assertions) && point.assertions.length > 0));
});
