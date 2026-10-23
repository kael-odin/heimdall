#!/usr/bin/env node
/** Real CDP console flow: click Forge, wait for the engine, open its artifact. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(CORE, 'test', 'fixtures', 'site');
const DIST = resolve(CORE, '..', 'console', 'dist');
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace', '_runs', 'console-cdp'));
const CDP = process.env.HEIMDALL_E2E_CDP_URL ?? 'http://127.0.0.1:9223';
const SELF_CDP = process.env.HEIMDALL_E2E_CDP_SELF === '1';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

assert.ok(existsSync(join(DIST, 'index.html')), 'build console/dist first');
mkdirSync(OUT, { recursive: true });

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('timed out waiting for ' + label);
}

async function waitExit(base, taskId) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 300_000);
  try {
    const response = await fetch(base + '/api/events?task=' + encodeURIComponent(taskId), { signal: abort.signal });
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!event.startsWith('data: ')) continue;
        const value = JSON.parse(event.slice(6));
        if (value.kind === 'exit') return value;
      }
    }
    throw new Error('event stream ended before exit');
  } finally { clearTimeout(timer); }
}

const fixture = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  const file = resolve(FIXTURE, '.' + (pathname === '/' ? '/index.html' : pathname));
  const rel = relative(FIXTURE, file);
  if (rel.startsWith('..' + sep) || rel === '..' || !existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

let engine;
let browser;
let cdpOwner;
let cdpUrl = CDP;
let page;
let fixturePort;
let dataRoot;
let engineLog = '';
let success = false;
try {
  fixturePort = await listen(fixture);
  const portServer = createServer();
  const port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-console-cdp-'));
  engine = spawn(process.execPath, ['src/engine-server.mjs', String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: DIST, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_LLM: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stdout.on('data', chunk => { engineLog += chunk; });
  engine.stderr.on('data', chunk => { engineLog += chunk; });
  await waitFor(async () => (await fetch(base + '/api/status')).ok, 30_000, 'engine');

  if (SELF_CDP) {
    const cdpPortServer = createServer();
    const cdpPort = await listen(cdpPortServer);
    await new Promise(resolve => cdpPortServer.close(resolve));
    cdpUrl = 'http://127.0.0.1:' + cdpPort;
    cdpOwner = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
    await waitFor(async () => (await fetch(cdpUrl + '/json/version')).ok, 30_000, 'CDP endpoint');
  }
  browser = await chromium.connectOverCDP(cdpUrl);
  page = await (browser.contexts()[0] ?? await browser.newContext()).newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const consoleResponse = await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  assert.equal(consoleResponse.status(), 200);
  await page.getByRole('button', { name: '只克隆此页' }).waitFor();
  const source = 'http://127.0.0.1:' + fixturePort + '/';
  await page.getByRole('textbox', { name: '目标站点域名' }).fill(source);
  const forgeResponse = page.waitForResponse(response => response.url() === base + '/api/forge' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '只克隆此页' }).click();
  const forge = await forgeResponse;
  const body = await forge.json();
  assert.equal(forge.status(), 200, JSON.stringify(body));
  assert.equal(body.url, source);
  const exit = await waitExit(base, body.taskId);
  assert.equal(exit.status, 'done', engineLog.slice(-3000));
  await page.locator('.tc-row.done').first().waitFor({ timeout: 15_000 });
  await page.locator('.wv-rows .wv-row:not(.wv-th)').first().waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(OUT, 'cdp-console-forge.png'), fullPage: true });

  const cloneUrl = base + '/static/127.0.0.1/pages/' + encodeURIComponent(body.pageName) + '/clone/index.html';
  const artifact = await page.goto(cloneUrl, { waitUntil: 'load' });
  assert.equal(artifact.status(), 200);
  assert.match(await page.locator('h1').first().innerText(), /Ship faster with a deterministic fixture/);
  assert.equal(await page.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0), true);
  await page.screenshot({ path: join(OUT, 'cdp-clone-artifact.png'), fullPage: true });
  assert.deepEqual(errors, [], 'browser page errors');
  const result = { ranAt: new Date().toISOString(), cdp: cdpUrl,
    cdpLaunch: SELF_CDP ? 'script-managed Chromium' : 'external browser', source, consoleUrl: base, taskId: body.taskId,
    taskStatus: exit.status, pageName: body.pageName, cloneStatus: artifact.status(), cloneTitle: await page.title(),
    screenshots: ['cdp-console-forge.png', 'cdp-clone-artifact.png'], pageErrors: errors };
  writeFileSync(join(OUT, 'cdp-real-forge.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  success = true;
} catch (error) {
  await page?.screenshot({ path: join(OUT, 'cdp-failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, 'cdp-real-forge-failure.txt'), String(error?.stack ?? error) + '\n\n' + engineLog.slice(-8000));
  throw error;
} finally {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await cdpOwner?.close().catch(() => {});
  if (engine && engine.exitCode === null) {
    engine.kill();
    await new Promise(resolve => { engine.once('exit', resolve); setTimeout(resolve, 5000); });
  }
  if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  if (success && dataRoot && resolve(dataRoot).startsWith(resolve(tmpdir(), 'heimdall-console-cdp-'))) {
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch {}
  }
}
