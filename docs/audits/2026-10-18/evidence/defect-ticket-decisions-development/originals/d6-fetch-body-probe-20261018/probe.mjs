import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url)), log = [], results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (event, data = {}) => log.push({ at: new Date().toISOString(), event, ...data });
let browser, proc;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/') { res.end('<!doctype html><title>Fetch completion probe</title><link rel="icon" href="data:,">'); return; }
  req.resume(); req.once('end', () => {
    const bytes = Buffer.from(url.searchParams.get('body') === 'empty' ? '' : '<!doctype html><title>Controlled 502</title>');
    for (const event of ['finish', 'close']) res.once(event, () => record('server-' + event, { path: req.url, writableFinished: res.writableFinished }));
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes.length, connection: 'close' });
    res.end(bytes);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  proc = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const active = join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(active) && i < 100; i++) await wait(100);
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0]);
  const context = await browser.newContext(), page = await context.newPage();
  const cdp = await context.newCDPSession(page), ids = new Map(); await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', event => { ids.set(event.requestId, event.request.url); record('cdp-request', { id: event.requestId, url: event.request.url }); });
  cdp.on('Network.responseReceived', event => record('cdp-response', { id: event.requestId, url: ids.get(event.requestId), status: event.response.status }));
  cdp.on('Network.loadingFinished', event => record('cdp-finished', { id: event.requestId, url: ids.get(event.requestId) }));
  cdp.on('Network.loadingFailed', event => record('cdp-failed', { id: event.requestId, url: ids.get(event.requestId), error: event.errorText, canceled: event.canceled }));
  page.on('requestfinished', req => record('pw-finished', { url: req.url() }));
  page.on('requestfailed', req => record('pw-failed', { url: req.url(), error: req.failure() }));
  await page.goto(base);
  for (const body of ['empty', 'html']) for (const mode of ['unread', 'throw', 'consume', 'cancel']) {
    const url = `${base}/case?body=${body}&mode=${mode}`;
    record('probe-start', { url });
    const value = await page.evaluate(async ({ url, mode }) => {
      try {
        const controller = new AbortController();
        const response = await fetch(url, { method: 'POST', body: '{}', signal: controller.signal });
        if (mode === 'throw') { if (response.headers.get('content-type') !== 'application/json') throw Error('MIME rejected'); }
        if (mode === 'consume') await response.arrayBuffer();
        if (mode === 'cancel') await response.body.cancel();
        return { status: response.status, bodyUsed: response.bodyUsed };
      } catch (cause) { return { error: cause.message }; }
    }, { url, mode });
    await wait(1200);
    const result = { body, mode, value, pwFinished: log.some(event => event.event === 'pw-finished' && event.url === url), cdpFinished: log.some(event => event.event === 'cdp-finished' && event.url === url), failed: log.filter(event => ['pw-failed', 'cdp-failed'].includes(event.event) && event.url === url) };
    results.push(result); record('probe-end', result); console.log(JSON.stringify(result));
  }
  record('before-teardown');
} finally {
  await browser?.close(); if (proc && proc.exitCode === null) { const exited = once(proc, 'exit'); proc.kill('SIGTERM'); await exited; }
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  fs.writeFileSync(join(OUT, 'log.json'), JSON.stringify(log, null, 2)); fs.writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
}
