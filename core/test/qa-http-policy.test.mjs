import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { newQaPage, qaBrowserLaunchOptions, routeQaRequest } from '../src/qa/http-policy.mjs';

async function fixture(t) {
  const requests = [];
  const servers = [];
  for (const name of ['site', 'other']) {
    const server = createServer((req, res) => {
      requests.push({ server: name, method: req.method, path: req.url });
      if (req.url === '/api/redirect' && req.method === 'POST') {
        res.writeHead(307, { location: '/api/query?from=redirect', 'access-control-allow-origin': '*' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
      res.end('<!doctype html><title>Local fixture</title>');
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    servers.push(server);
  }
  const [site, other] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    for (const server of servers) server.close();
  });
  return { browser, site, other, requests };
}

test('qa legacy path prefixes fail closed for methods, paths and origins', { timeout: 30000 }, async t => {
  const { browser, site, other, requests } = await fixture(t);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const config = { origin: site, writes: 'block', writeAllow: ['/api/query'] };
  await context.route('**/*', route => routeQaRequest(route, { site: config }));
  const page = await newQaPage(context, { site: config });
  await page.goto(site);
  await page.evaluate(async otherOrigin => {
    for (const [url, method] of [
      ['/api/query', 'POST'], ['/api/query', 'DELETE'], ['/api/queryAnything', 'POST'],
      ['/api/query/delete', 'POST'], [`${otherOrigin}/api/query`, 'POST'],
    ]) await fetch(url, { method }).catch(() => {});
  }, other);
  const received = requests.filter(request => request.method !== 'GET' && request.method !== 'OPTIONS');
  assert.deepEqual(received, [], 'legacy prefix rules must not authorize any non-read requests');
  await context.close();
});

test('qa query rules require an exact method, origin and path and reject redirects and unowned pages', { timeout: 30000 }, async t => {
  const { browser, site, other, requests } = await fixture(t);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const config = { origin: site, writes: 'block', writeAllow: [
    { method: 'POST', origin: site, path: '/api/query' },
    { method: 'POST', origin: site, path: '/api/redirect' },
    { method: 'POST', origin: other, path: '/api/remote' },
  ] };
  const blocked = [];
  await context.route('**/*', route => routeQaRequest(route, { site: config, onBlocked: (req, reason) => blocked.push({ method: req.method(), url: req.url(), reason }) }));
  const page = await newQaPage(context, { site: config });
  await page.goto(site);
  await page.evaluate(async otherOrigin => {
    for (const [url, method] of [
      ['/api/query?filter=1', 'POST'], [`${otherOrigin}/api/remote`, 'POST'], ['/api/query', 'GET'],
      ['/api/query', 'DELETE'], ['/api/query', 'PUT'], ['/api/query', 'PATCH'],
      ['/api/queryAnything', 'POST'], ['/api/query/delete', 'POST'], ['/api/query/', 'POST'],
      [`${otherOrigin}/api/query`, 'POST'], ['/api/redirect', 'POST'],
    ]) await fetch(url, { method }).catch(() => {});
    await new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.onload = resolve;
      frame.src = `${otherOrigin}/frame`;
      document.body.append(frame);
    });
  }, other);
  const foreign = page.frames().find(frame => frame.url() === `${other}/frame`);
  assert.ok(foreign, 'the untrusted frame actually loaded');
  await foreign.evaluate(async target => fetch(`${target}/api/query`, { method: 'POST' }).catch(() => {}), site);
  const popupPromise = context.waitForEvent('page');
  await page.evaluate(target => window.open(`${target}/popup`), site);
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await popup.evaluate(async () => fetch('/api/query', { method: 'POST' }).catch(() => {}));

  const received = requests.filter(request => !['GET', 'OPTIONS'].includes(request.method));
  assert.deepEqual(received, [
    { server: 'site', method: 'POST', path: '/api/query?filter=1' },
    { server: 'other', method: 'POST', path: '/api/remote' },
    { server: 'site', method: 'POST', path: '/api/redirect' },
  ]);
  assert.equal(blocked.length, 10, 'unexpected methods, similar paths, origin, redirect, foreign frame and popup are blocked');
  assert.equal(blocked.filter(item => item.reason === 'redirect').length, 1, 'a redirect is distinguished from a request blocked before sending');
  assert.equal(blocked.filter(item => item.reason === 'untrusted-page').length, 2);
  assert.ok(requests.some(request => request.method === 'GET' && request.path === '/api/query'));
  await context.close();
});

test('qa header login: a same-origin popup cannot receive credentials through a permitted query', { timeout: 30000 }, async t => {
  const { site, requests } = await fixture(t);
  const login = { contextOptions: { extraHTTPHeaders: { Authorization: 'fixture-header-secret' } } };
  const browser = await chromium.launch(qaBrowserLaunchOptions(login));
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const config = { origin: site, writes: 'block', writeAllow: [{ method: 'POST', origin: site, path: '/api/query' }] };
  await context.route('**/*', route => routeQaRequest(route, { site: config, login }));
  const page = await newQaPage(context, { site: config, login });
  await page.goto(site);
  const popupPromise = context.waitForEvent('page');
  await page.evaluate(target => window.open(`${target}/popup`), site);
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await popup.evaluate(async () => fetch('/api/query', { method: 'POST' }).catch(() => {}));
  assert.ok(!requests.some(request => request.method === 'POST' && request.path === '/api/query'));
  await context.close();
});
