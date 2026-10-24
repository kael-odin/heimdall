/**
 * Cross-tab receipt writes must not lose updates in a real browser.
 *
 * The receipt stores used to serialize "read localStorage -> modify -> write
 * back" with Web Locks. A lock admits one holder at a time but does not make
 * another tab's localStorage write visible to that holder: under load the
 * holder read a stale collection and wrote a resolved confirmation back
 * (CI run 40080692099; a local probe lost 300 of 300 updates). The stores now
 * decide every write inside an IndexedDB readwrite transaction.
 *
 * Node has no IndexedDB, so the unit suites only cover the fallback path. This
 * test loads the real console modules into two Chromium tabs, keeps other tabs
 * writing localStorage to create the pressure that exposed the bug, and runs
 * the exact interleaving that failed: tab A resolves a receipt while tab B,
 * queued behind the same lock, appends one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const CONSOLE_SRC = new URL('../../console/src/', import.meta.url);
const MODULES = new Set(['acceptance-browser-execution.js', 'acceptance-defect-tickets.js', 'receipt-collections.js']);

async function serve(t) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://local.test').pathname.slice(1);
    if (MODULES.has(name)) {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      return response.end(readFileSync(new URL(name, CONSOLE_SRC)));
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>receipts</title>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const request = () => ({ operationId: 'bo-' + randomUUID(), expectedGenerationId: 'ag-' + randomUUID(), expectedRevision: 3,
  candidateId: 'bc-' + randomUUID(), contentDigest: 'a'.repeat(64), targetReleaseId: 'ar-' + randomUUID() });

test('two tabs resolving and appending receipts under storage pressure never resurrect a resolved one', { timeout: 240_000 }, async t => {
  const origin = await serve(t);
  // Full Chromium, not the default headless shell: the shell keeps same-origin tabs in one
  // renderer process, where localStorage is trivially coherent and the bug cannot appear.
  // Separate renderer processes are what the console runs in, and what lost the updates.
  const browser = await chromium.launch({ channel: 'chromium', args: ['--site-per-process', '--renderer-process-limit=8'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const [A, B, ...noise] = await Promise.all(Array.from({ length: 4 }, () => context.newPage()));
  for (const page of [A, B, ...noise]) await page.goto(origin + '/');
  // Other tabs hammering localStorage are what made the stale reads common enough to see.
  // Bounded so the headless shell itself survives: 2 tabs x 10 writes x 1 KB every 2 ms.
  for (const page of noise) await page.evaluate(() => { let n = 0; setInterval(() => { for (let i = 0; i < 10; i++) localStorage.setItem('noise-' + (n++ % 20), 'x'.repeat(1000)); }, 2); });

  const projectId = 'ap-' + randomUUID(), key = `heimdall:browser-operations:v1:${origin}:${projectId}`;
  for (const page of [A, B]) {
    await page.evaluate(async ({ projectId, origin }) => {
      const module = await import('/acceptance-browser-execution.js');
      window.__client = module.createBrowserExecutionReceipts({ projectId, origin, storage: localStorage });
    }, { projectId, origin });
  }

  const ROUNDS = 40;
  const lost = [];
  for (let round = 0; round < ROUNDS; round++) {
    const stale = request(), kept = request(), added = request();
    await A.evaluate(async ({ stale, kept }) => { for (const value of await window.__client.read()) await window.__client.resolveExact(value);
      await window.__client.save(stale); await window.__client.save(kept); }, { stale, kept });
    // Hold the lock from A so both writes queue, then release: A resolves, B appends.
    await A.evaluate(key => { window.__held = false;
      window.__hold = navigator.locks.request(key, { mode: 'exclusive' }, () => new Promise(resolve => { window.__held = true; window.__release = resolve; })); }, key);
    await A.waitForFunction(() => window.__held === true);
    await A.evaluate(value => { window.__write = window.__client.resolveExact(value); }, stale);
    await B.evaluate(value => { window.__write = window.__client.save(value); }, added);
    await A.waitForFunction(async key => (await navigator.locks.query()).pending.filter(item => item.name === key).length === 2, key);
    await A.evaluate(() => window.__release());
    await Promise.all([A.evaluate(() => window.__write), B.evaluate(() => window.__write)]);
    const ids = await A.evaluate(() => window.__client.read().map(value => value.operationId));
    if (ids.includes(stale.operationId) || !ids.includes(kept.operationId) || !ids.includes(added.operationId)) lost.push({ round, ids });
  }
  assert.deepEqual(lost, [], `${lost.length}/${ROUNDS} rounds lost or resurrected a receipt`);

  // The mirror both tabs read synchronously agrees with the authoritative copy.
  const views = await Promise.all([A, B].map(page => page.evaluate(() => window.__client.read().map(value => value.operationId).sort())));
  assert.deepEqual(views[0], views[1]);
});

test('receipts written by the localStorage-only version are adopted, not dropped, on the first write', { timeout: 60_000 }, async t => {
  const origin = await serve(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.goto(origin + '/');
  const projectId = 'ap-' + randomUUID(), legacy = request(), next = request();
  const ids = await page.evaluate(async ({ projectId, origin, legacy, next }) => {
    localStorage.setItem(`heimdall:browser-operations:v1:${origin}:${projectId}`, JSON.stringify([legacy]));
    const module = await import('/acceptance-browser-execution.js');
    const client = module.createBrowserExecutionReceipts({ projectId, origin, storage: localStorage });
    await client.save(next);
    return client.read().map(value => value.operationId);
  }, { projectId, origin, legacy, next });
  assert.deepEqual(ids, [legacy.operationId, next.operationId]);
});

test('defect tickets: two tabs claiming at once admit exactly one confirmation, and it survives', { timeout: 240_000 }, async t => {
  const origin = await serve(t);
  const browser = await chromium.launch({ channel: 'chromium', args: ['--site-per-process', '--renderer-process-limit=8'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const [A, B, ...noise] = await Promise.all(Array.from({ length: 4 }, () => context.newPage()));
  for (const page of [A, B, ...noise]) await page.goto(origin + '/');
  for (const page of noise) await page.evaluate(() => { let n = 0; setInterval(() => { for (let i = 0; i < 10; i++) localStorage.setItem('noise-' + (n++ % 20), 'x'.repeat(1000)); }, 2); });
  const projectId = 'ap-' + randomUUID(), key = `heimdall:defect-tickets:v1:${origin}:${projectId}`;
  const install = ({ projectId, origin }) => import('/acceptance-defect-tickets.js').then(module => {
    window.__module = module;
    window.__client = module.createDefectTicketReceipts({ projectId, origin, storage: localStorage });
  });
  for (const page of [A, B]) await page.evaluate(install, { projectId, origin });
  const confirmationFor = (page, n) => page.evaluate(async ({ projectId, n }) => {
    const uuid = () => crypto.randomUUID();
    const ticketId = 'dt-' + uuid();
    return window.__module.defectTicketConfirmation({ projectId, ticketId, kind: 'create', request: {
      ticketId, actionId: 'da-' + uuid(), sourceOperationId: 'bo-' + uuid(), memberCheckIds: ['desktop'],
      title: 'Claim race ' + n, severity: 'high', description: 'Two tabs claim at once.', reproduction: '1. Open two tabs' } });
  }, { projectId, n });

  const ROUNDS = 30, broken = [];
  for (let round = 0; round < ROUNDS; round++) {
    const a = await confirmationFor(A, round), b = await confirmationFor(B, round);
    await A.evaluate(key => { window.__held = false;
      window.__hold = navigator.locks.request(key, { mode: 'exclusive' }, () => new Promise(resolve => { window.__held = true; window.__release = resolve; })); }, key);
    await A.waitForFunction(() => window.__held === true);
    await A.evaluate(value => { window.__claim = window.__client.claimForSubmit(value); }, a);
    await B.evaluate(value => { window.__claim = window.__client.claimForSubmit(value); }, b);
    await A.waitForFunction(async key => (await navigator.locks.query()).pending.filter(item => item.name === key).length === 2, key);
    await A.evaluate(() => window.__release());
    const won = await Promise.all([A.evaluate(() => window.__claim), B.evaluate(() => window.__claim)]);
    const held = await A.evaluate(() => window.__client.read().map(value => value.actionId));
    const winners = won.filter(Boolean).length, winner = won[0] ? a : b;
    // Zero winners means both tabs read a stale, non-empty collection; two means both read it empty.
    if (winners !== 1 || held.length !== 1 || held[0] !== winner.actionId) { broken.push({ round, won, held }); break; }
    // Clear the winner through the tab that owns the unsent claim, ready for the next round.
    await (won[0] ? A : B).evaluate(value => window.__client.cancelUnsent(value), winner);
  }
  assert.deepEqual(broken, [], `${broken.length}/${ROUNDS} rounds admitted two claims or lost the winner`);
});
