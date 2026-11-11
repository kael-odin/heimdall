import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { createAcceptanceRun, finishAcceptanceRun, readAcceptanceSnapshot, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { compileFixedBrowserContract } from '../src/acceptance/browser-fixed-contract.mjs';
import { runFixedBrowserAcceptance } from '../src/acceptance/browser-fixed-runner.mjs';
import { browserFixedFixture } from './fixtures/acceptance-browser-fixed.mjs';

test('initial redirects cannot pass or execute declared actions on another page', { timeout: 90_000 }, async t => {
  const clicks = [], marker = 'REDIRECT_PRIVATE_VALUE_7821';
  let origin, otherOrigin;
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/clicked') { clicks.push(url.searchParams.get('case') + ':' + url.searchParams.get('side')); res.end('ok'); return; }
    const [, side, name] = url.pathname.split('/');
    const redirect = location => { res.writeHead(302, { location }); res.end(); };
    if (name === 'jump' && side === 'target') return redirect(`/baseline/jump?secret=${marker}#${marker}`);
    if (name === 'baseline-jump' && side === 'baseline') return redirect(`/target/baseline-jump?secret=${marker}`);
    if (name === 'cross' && side === 'target' && req.headers.host === new URL(origin).host) return redirect(`${otherOrigin}/target/cross?secret=${marker}`);
    if (name === 'chain' && side === 'target' && !req.headers.cookie) return redirect(`/target/hop?secret=${marker}`);
    if (name === 'hop') { res.setHeader('set-cookie', 'fixture=1; Path=/'); return redirect('/target/chain'); }
    if (name === 'query' && side === 'target' && !url.search) return redirect(`/target/query?secret=${marker}`);
    res.setHeader('content-type', 'text/html');
    const navigation = name === 'hash' && side === 'target' ? `history.replaceState(null, '', '#${marker}');`
      : name === 'js' && side === 'target' ? `setTimeout(() => location.replace('/baseline/js?secret=${marker}'), 10);` : '';
    const action = name === 'action' ? `location.href='/${side}/destination'`
      : `fetch('/clicked?case=${name}&side=${side}')`;
    res.end(`<!doctype html><html><head><title>Local fixture</title></head><body><h1>Fixture</h1><button id="action" onclick="${action}">Go</button><script>${navigation}</script></body></html>`);
  };
  const servers = [createServer(handler), createServer(handler)];
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  origin = `http://127.0.0.1:${servers[0].address().port}`;
  otherOrigin = `http://127.0.0.1:${servers[1].address().port}`;
  const outputDir = await mkdtemp(join(tmpdir(), 'acceptance-navigation-'));
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(outputDir, { recursive: true, force: true });
  });
  const routes = ['/jump', '/baseline-jump', '/cross', '/chain', '/query', '/hash', '/js', '/action'];
  const plan = normalizeAcceptancePlan({ name: 'Navigation integrity', mode: 'mirror',
    baselineUrl: `${origin}/baseline/`, targetUrl: `${origin}/target/`, routes,
    viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 10_000, settleMs: 100,
    points: routes.map(route => ({ id: route.slice(1), title: route.slice(1), route,
      steps: [{ action: 'click', selector: '#action' }],
      assertions: route === '/action' ? [{ kind: 'url', contains: '/destination' }] : [{ kind: 'visible', selector: '#action' }] })) });
  const report = summarizeAcceptanceReport(await runAcceptance(plan, { outputDir }));
  assert.equal(report.gate, 'blocked');
  for (const route of routes.slice(0, -1)) {
    const checks = report.checks.filter(check => check.route === route);
    assert.equal(checks.length, 7, route);
    assert.ok(checks.every(check => check.status === 'blocked' && check.verdict !== 'bug'), route);
    const behavior = checks.find(check => check.dimension === 'behavior');
    assert.ok(behavior.evaluationLimited, route);
  }
  assert.ok(report.checks.filter(check => check.route === '/action').every(check => check.status === 'passed'));
  assert.equal(clicks.filter(click => click === 'jump:baseline').length, 1);
  assert.equal(clicks.filter(click => click === 'baseline-jump:target').length, 1);
  for (const name of ['cross', 'chain', 'query', 'hash', 'js']) assert.equal(clicks.filter(click => click === `${name}:target`).length, 0, name);
  const files = await readdir(outputDir);
  const text = [JSON.stringify(report), ...await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readFile(join(outputDir, file), 'utf8')))];
  assert.ok(text.every(value => !value.includes(marker)), 'Unexpected destination values must not enter the report or detail evidence.');
});

test('a delayed initial navigation during locator waiting cannot receive the first action', { timeout: 30_000 }, async t => {
  let wrongClicks = 0;
  const server = createServer((req, res) => {
    if (req.url === '/wrong-click') { wrongClicks++; res.end('ok'); return; }
    res.setHeader('content-type', 'text/html');
    const target = req.url.startsWith('/target');
    const wrong = req.url === '/target/wrong';
    const body = target && !wrong ? '<script>setTimeout(() => location.replace("/target/wrong"), 400)</script>'
      : `<button id="action" onclick="${wrong ? "fetch('/wrong-click')" : ''}">Go</button>`;
    res.end(`<!doctype html><html><body><h1>Fixture</h1>${body}</body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const outputDir = await mkdtemp(join(tmpdir(), 'acceptance-navigation-wait-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outputDir, { recursive: true, force: true }); });
  const plan = normalizeAcceptancePlan({ name: 'Delayed navigation', mode: 'mirror', baselineUrl: `${origin}/baseline`, targetUrl: `${origin}/target`,
    routes: ['/'], viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 5_000, settleMs: 50,
    points: [{ id: 'click', title: 'Click', route: '/', steps: [{ action: 'click', selector: '#action' }], assertions: [{ kind: 'visible', selector: '#action' }] }] });
  const report = summarizeAcceptanceReport(await runAcceptance(plan, { outputDir }));
  const behavior = report.checks.find(check => check.dimension === 'behavior');
  assert.equal(behavior.status, 'blocked');
  assert.equal(behavior.verdict, 'environment');
  assert.equal(wrongClicks, 0);
});

test('an HTTP redirect back to the same declared URL is still an unverified initial chain', { timeout: 20_000 }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/target' && !req.headers.cookie) {
      res.writeHead(302, { location: '/target', 'set-cookie': 'fixture=1; Path=/' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><h1>Fixture</h1>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, outputDir = await mkdtemp(join(tmpdir(), 'acceptance-self-redirect-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outputDir, { recursive: true, force: true }); });
  const plan = normalizeAcceptancePlan({ name: 'Same URL redirect', baselineUrl: `${origin}/baseline`, targetUrl: `${origin}/target`,
    routes: ['/'], viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 5000, settleMs: 50 });
  const report = summarizeAcceptanceReport(await runAcceptance(plan, { outputDir }));
  assert.equal(report.gate, 'blocked');
  assert.ok(report.checks.every(check => check.status === 'blocked' && check.verdict !== 'bug'));
});

test('a same-URL reload before the first action cannot silently replace the initial document', { timeout: 20_000 }, async t => {
  let wrongClicks = 0;
  const server = createServer((req, res) => {
    if (req.url === '/wrong-click') { wrongClicks++; res.end('ok'); return; }
    const reload = req.url === '/target' && !req.headers.cookie;
    if (reload) res.setHeader('set-cookie', 'reloaded=1; Path=/');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>Fixture</h1>${reload
      ? '<script>setTimeout(() => location.reload(), 20)</script>'
      : `<button id="action" onclick="${req.url === '/target' ? "fetch('/wrong-click')" : ''}">Go</button>`}</body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, outputDir = await mkdtemp(join(tmpdir(), 'acceptance-reload-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outputDir, { recursive: true, force: true }); });
  const plan = normalizeAcceptancePlan({ name: 'Same URL reload', baselineUrl: `${origin}/baseline`, targetUrl: `${origin}/target`,
    routes: ['/'], viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 5000, settleMs: 150,
    points: [{ id: 'click', title: 'Click', route: '/', steps: [{ action: 'click', selector: '#action' }], assertions: [{ kind: 'visible', selector: '#action' }] }] });
  const report = summarizeAcceptanceReport(await runAcceptance(plan, { outputDir }));
  assert.equal(report.gate, 'blocked');
  assert.equal(report.checks.find(check => check.dimension === 'behavior').status, 'blocked');
  assert.equal(wrongClicks, 0);
});

test('fixed historical baseline blocks redirected targets without clicking or recording destination values', { timeout: 60_000 }, async t => {
  const fixture = await browserFixedFixture(), marker = 'FIXED_PRIVATE_REDIRECT_7821';
  let clicks = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/candidate')) { res.writeHead(302, { location: `/wrong?secret=${marker}` }); res.end(); return; }
    if (req.url === '/clicked') { clicks++; res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>Fixture</h1><button id="menu-toggle" onclick="fetch(\'/clicked\')">Go</button><div id="menu">Menu</div>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, outputDir = await mkdtemp(join(tmpdir(), 'acceptance-fixed-redirect-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outputDir, { recursive: true, force: true }); });
  const { contract, sourceFiles } = compileFixedBrowserContract({ material: fixture.material, review: fixture.review, candidate: fixture.candidate,
    targetRelease: { ...fixture.targetRelease, targetUrl: `${origin}/candidate` } });
  const report = await runFixedBrowserAcceptance(contract, { runId: `br-${randomUUID()}`, outputDir, sourceFiles });
  assert.equal(report.checks.length, 28);
  assert.ok(report.checks.every(check => check.status === 'blocked' && check.verdict !== 'bug'));
  for (const check of report.checks.filter(check => check.dimension === 'behavior')) {
    assert.equal(check.actual.navigationError.code, 'BROWSER_INITIAL_URL_CHANGED');
    assert.equal(check.actual.stepsComplete, false);
  }
  assert.equal(clicks, 0);
  const files = await readdir(outputDir);
  const texts = [JSON.stringify(report), ...await Promise.all(files.filter(file => file.endsWith('-target.json')).map(file => readFile(join(outputDir, file), 'utf8')))];
  assert.ok(texts.every(value => !value.includes(marker)));
});

test('new source projection preserves the healthy side and rejects the redirected side', { timeout: 30_000 }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/target') { res.writeHead(302, { location: '/wrong' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture</h1><button id="action">Go</button></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, root = await mkdtemp(join(tmpdir(), 'acceptance-projection-redirect-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const plan = normalizeAcceptancePlan({ name: 'Source projection', baselineUrl: `${origin}/baseline`, targetUrl: `${origin}/target`,
    routes: ['/'], viewports: [{ name: 'mobile', width: 375, height: 812 }], timeoutMs: 5000, settleMs: 50,
    points: [{ id: 'click', title: 'Click', route: '/', steps: [{ action: 'click', selector: '#action' }], assertions: [{ kind: 'visible', selector: '#action' }] }] });
  const run = createAcceptanceRun(plan, { root }), dir = acceptanceRunDir(run.runId, root);
  finishAcceptanceRun(run.runId, await runAcceptance(plan, { runId: run.runId, outputDir: dir }), { root });
  const snapshot = readAcceptanceSnapshot(run.runId, { root });
  assert.equal(snapshot.integrity.valid, true, JSON.stringify(snapshot.integrity));
  const names = new Set(['manifest.json', 'report.json', ...snapshot.report.checks.flatMap(check => Object.values(check.evidence)).filter(Boolean)]);
  const files = new Map(await Promise.all([...names].map(async name => [name, await readFile(join(dir, name))])));
  const material = { snapshot, files };
  const baseline = projectBrowserBaselineCandidate(material, { sourceSide: 'baseline' });
  assert.equal(baseline.projection.verifierFingerprint, snapshot.report.verifierFingerprint);
  assert.throws(() => projectBrowserBaselineCandidate(material, { sourceSide: 'target' }), error =>
    error.code === 'SOURCE_NOT_ELIGIBLE' && error.details?.reason === 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE');
});
