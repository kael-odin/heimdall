import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SOURCE = fileURLToPath(new URL('../src/live/', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('live server did not start: ' + url);
}

test('independent live bundle completes cookie login, redirect and POST/API round trip', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-live-serve-'));
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/sign-in' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head></head><body><form action="/login" method="post"><input name="user"><button type="submit">Sign in</button></form></body></html>');
    }
    if (req.url === '/docs/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head></head><body><a href="next">Next</a></body></html>');
    }
    if (req.url === '/docs/next' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head></head><body><h1>Nested page</h1></body></html>');
    }
    if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': ['sid=ok; Path=/; Domain=fixture.test; Secure; HttpOnly', 'theme=dark; Path=/'] });
      return res.end();
    }
    if (req.url === '/dashboard') {
      const authorized = req.headers.cookie?.includes('sid=ok');
      res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'text/html' });
      return res.end(authorized ? '<html><h1>dashboard</h1></html>' : '<html><h1>unauthorized</h1></html>');
    }
    if (req.url === '/api/echo' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ body, cookie: req.headers.cookie ?? '' }));
    }
    if (req.url === '/logout' && req.method === 'POST') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      return res.end();
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const originPort = upstream.address().port;
  const livePort = await freePort();
  const base = `http://127.0.0.1:${livePort}`;
  mkdirSync(join(dir, 'site', 'live', 'login'), { recursive: true });
  writeFileSync(join(dir, 'site', 'live', 'login', 'index.html'), '<html>snapshot</html>');
  writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({ host: 'fixture.test', origin: `http://127.0.0.1:${originPort}`, port: livePort, bind: '127.0.0.1', root: 'landing' }));
  writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
  copyFileSync(join(SOURCE, 'serve.mjs'), join(dir, 'serve.mjs'));
  copyFileSync(join(SOURCE, 'har.mjs'), join(dir, 'har.mjs'));
  copyFileSync(join(SOURCE, 'live-path.mjs'), join(dir, 'live-path.mjs'));
  copyFileSync(join(SOURCE, 'clone-asset-cors.mjs'), join(dir, 'clone-asset-cors.mjs'));
  const child = spawn(process.execPath, [join(dir, 'serve.mjs')], { stdio: 'ignore' });
  let browser;
  try {
    await ready(base + '/__heimdall/health');
    const malformed = await fetch(base + '/static/%');
    assert.equal(malformed.status, 400);
    assert.equal(child.exitCode, null, 'malformed URL must not stop the live server');
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
    const local = await fetch(base + '/lm/fixture.test/login');
    assert.match(await local.text(), /snapshot/);

    const login = await fetch(base + '/lm/fixture.test/login', { method: 'POST', body: 'user=a', redirect: 'manual' });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/lm/fixture.test/dashboard');
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some(c => c.startsWith('sid=ok')));
    const cookie = cookies.map(c => c.split(';')[0]).join('; ');

    const dashboard = await fetch(base + '/lm/fixture.test/dashboard', { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /dashboard/);

    const api = await fetch(base + '/lm/fixture.test/api/echo', { method: 'POST', headers: { cookie, 'Content-Type': 'text/plain' }, body: 'payload' });
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { body: 'payload', cookie });

    const logout = await fetch(base + '/lm/fixture.test/logout', { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/lm/fixture.test/login');
    assert.ok(logout.headers.getSetCookie()[0].includes('Max-Age=0'));

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base + '/lm/fixture.test/login');
    const browserResult = await page.evaluate(async () => {
      const login = await fetch('/lm/fixture.test/login', { method: 'POST', body: 'user=a' });
      const dashboard = await fetch('/lm/fixture.test/dashboard');
      return { login: login.status, dashboard: dashboard.status, body: await dashboard.text() };
    });
    assert.equal(browserResult.login, 200);
    assert.equal(browserResult.dashboard, 200);
    assert.match(browserResult.body, /dashboard/);

    const formPage = await browser.newPage();
    await formPage.goto(base + '/lm/fixture.test/sign-in');
    assert.equal(await formPage.locator('form').getAttribute('action'), '/lm/fixture.test/login');
    await formPage.locator('input[name="user"]').fill('a');
    const dashboardResponse = formPage.waitForResponse(response => response.url() === base + '/lm/fixture.test/dashboard');
    await formPage.getByRole('button', { name: 'Sign in' }).click();
    assert.equal((await dashboardResponse).status(), 200, 'browser form must carry the upstream login cookie');
    assert.equal(await formPage.locator('h1').innerText(), 'dashboard');

    const nestedPage = await browser.newPage();
    await nestedPage.goto(base + '/lm/fixture.test/docs/');
    assert.equal(await nestedPage.locator('base').getAttribute('href'), '/lm/fixture.test/docs/');
    await nestedPage.getByRole('link', { name: 'Next' }).click();
    assert.equal(new URL(nestedPage.url()).pathname, '/lm/fixture.test/docs/next');
    assert.equal(await nestedPage.locator('h1').innerText(), 'Nested page');
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('root mirror keeps relative navigation on the original pathname', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-live-root-'));
  const upstream = createServer((req, res) => {
    if (req.url === '/docs/api/data' || req.url === '/saved/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ path: req.url }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/docs/') return res.end('<html><head></head><body><a href="next">Next</a><a href="http://fixture.test/docs/next">Absolute next</a><a href="http://fixture.test.evil/docs/next">External next</a></body></html>');
    if (req.url === '/docs/next') return res.end('<html><head></head><body><h1>Next page</h1></body></html>');
    if (req.url === '/saved/next') return res.end('<html><head></head><body><h1>Saved next page</h1></body></html>');
    res.end('<html><head></head><body><h1>Other page</h1></body></html>');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const livePort = await freePort();
  const base = `http://127.0.0.1:${livePort}`;
  mkdirSync(join(dir, 'site', 'live'), { recursive: true });
  mkdirSync(join(dir, 'site', 'live', 'saved'), { recursive: true });
  writeFileSync(join(dir, 'site', 'live', 'saved', 'index.html'), '<html><head><base href="/lm/fixture.test/saved/"></head><body><a href="next">Saved next</a></body></html>');
  writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({ host: 'fixture.test', origin: `http://127.0.0.1:${upstream.address().port}`, port: livePort, bind: '127.0.0.1', root: 'mirror' }));
  writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
  for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs', 'clone-asset-cors.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));
  const child = spawn(process.execPath, [join(dir, 'serve.mjs')], { stdio: 'ignore' });
  let browser;
  try {
    await ready(base + '/__heimdall/health');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base + '/docs/');
    assert.equal(await page.locator('base').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Absolute next' }).getAttribute('href'), '/docs/next');
    assert.equal(await page.getByRole('link', { name: 'External next' }).getAttribute('href'), 'http://fixture.test.evil/docs/next');
    assert.deepEqual(await page.evaluate(() => fetch('api/data').then(r => r.json())), { path: '/docs/api/data' });
    await page.getByRole('link', { name: 'Next', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/docs/next');
    assert.equal(await page.locator('h1').innerText(), 'Next page');
    await page.goto(base + '/saved/');
    assert.equal(await page.locator('base').getAttribute('href'), '/saved/');
    assert.deepEqual(await page.evaluate(() => fetch('api/data').then(r => r.json())), { path: '/saved/api/data' });
    await page.getByRole('link', { name: 'Saved next' }).click();
    assert.equal(new URL(page.url()).pathname, '/saved/next');
    assert.equal(await page.locator('h1').innerText(), 'Saved next page');
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
