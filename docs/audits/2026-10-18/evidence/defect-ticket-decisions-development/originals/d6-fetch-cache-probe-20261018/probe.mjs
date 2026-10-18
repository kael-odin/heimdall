import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url)), log = [], results = [];
const CORE = resolve(OUT, '../../..'), helper = fs.readFileSync(resolve(CORE, '../console/src/acceptance-defect-tickets.js'));
const original = JSON.parse(fs.readFileSync(resolve(OUT, '../defect-ticket-decisions-console-smoke-20261018T091823020/case-A/original-confirmation.json')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (event, data = {}) => log.push({ at: new Date().toISOString(), event, ...data });
let browser, proc, responseCache;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/') { res.end('<!doctype html><title>Fetch helper probe</title><link rel="icon" href="data:,"><button id="run">Run</button><script type="module">import {requestDefectTickets} from "/helper.mjs";window.requestDefectTickets=requestDefectTickets;</script>'); return; }
  if (url.pathname === '/helper.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(helper); return; }
  req.resume(); req.once('end', () => {
    const bytes = Buffer.from('<!doctype html><title>Controlled D6 HTTP response</title><p>Manual outcome remains unknown.</p>');
    for (const event of ['finish', 'close']) res.once(event, () => record('server-' + event, { path: req.url, writableFinished: res.writableFinished }));
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes.length, connection: 'close', ...(responseCache === 'unspecified' ? {} : { 'cache-control': responseCache }) }); res.end(bytes);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  proc = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const active = join(profile, 'DevToolsActivePort'); for (let i = 0; !fs.existsSync(active) && i < 100; i++) await wait(100);
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + fs.readFileSync(active, 'utf8').split('\n')[0]);
  const context = await browser.newContext(), page = await context.newPage();
  const cdp = await context.newCDPSession(page), ids = new Map(); await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', event => { ids.set(event.requestId, event.request.url); record('cdp-request', { id: event.requestId, url: event.request.url }); });
  cdp.on('Network.responseReceived', event => record('cdp-response', { id: event.requestId, url: ids.get(event.requestId), status: event.response.status }));
  cdp.on('Network.loadingFinished', event => record('cdp-finished', { id: event.requestId, url: ids.get(event.requestId) }));
  cdp.on('Network.loadingFailed', event => record('cdp-failed', { id: event.requestId, url: ids.get(event.requestId), error: event.errorText, canceled: event.canceled }));
  page.on('requestfinished', req => record('pw-finished', { url: req.url() })); page.on('requestfailed', req => record('pw-failed', { url: req.url(), error: req.failure() }));
  await page.goto(base); await page.waitForFunction(() => typeof window.requestDefectTickets === 'function');
  for (const cache of ['unspecified', 'no-store', 'public, max-age=0']) for (const mode of ['native-full-options', 'helper']) {
    responseCache = cache;
    const path = `/api/acceptance/projects/${original.projectId}/defect-tickets`, url = base + path;
    const from = log.length; record('probe-start', { mode, url });
    const value = await page.evaluate(async ({ url, mode, original }) => {
      async function run() {
        try {
          if (mode.startsWith('helper')) return await window.requestDefectTickets(original.projectId, '', { method: 'POST', body: original.request });
          const controller = new AbortController(), options = { method: 'POST', body: JSON.stringify(original.request), signal: controller.signal };
          if (mode !== 'native') options.cache = 'no-store';
          if (['native-full-options', 'abortable'].includes(mode)) Object.assign(options, { credentials: 'omit', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/json' } });
          const response = mode === 'abortable' ? await (async () => {
            let rejectAbort; const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new DOMException('Aborted', 'AbortError')); });
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            try { return await Promise.race([fetch(url, options), aborted]); } finally { controller.signal.removeEventListener('abort', rejectAbort); }
          })() : await fetch(url, options);
          if (response.headers.get('content-type') !== 'application/json') throw Error('MIME rejected');
          return { status: response.status, bodyUsed: response.bodyUsed };
        } catch (cause) { return { error: cause.message }; }
      }
      if (mode === 'helper-click') { window.probeValue = null; document.querySelector('#run').onclick = async () => { window.probeValue = await run(); }; return { armed: true }; }
      return await run();
    }, { url, mode, original });
    if (mode === 'helper-click') { await page.locator('#run').click(); await page.waitForFunction(() => window.probeValue !== null); value.result = await page.evaluate(() => window.probeValue); }
    await wait(2000); const events = log.slice(from);
    const result = { cache, mode, value, pwFinished: events.some(event => event.event === 'pw-finished' && event.url === url), cdpFinished: events.some(event => event.event === 'cdp-finished' && event.url === url), failed: events.filter(event => ['pw-failed', 'cdp-failed'].includes(event.event) && event.url === url) };
    results.push(result); record('probe-end', result); console.log(JSON.stringify(result));
  }
  record('before-teardown');
} finally {
  await browser?.close(); if (proc && proc.exitCode === null) { const exited = once(proc, 'exit'); proc.kill('SIGTERM'); await exited; }
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  fs.writeFileSync(join(OUT, 'log.json'), JSON.stringify(log, null, 2)); fs.writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
}

