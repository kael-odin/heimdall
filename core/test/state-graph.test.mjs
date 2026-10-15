import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { classifyOperationRequest, exploreOperationStates, sanitizeObservedUrl } from '../src/crawler/state-graph.mjs';

async function fixture(t) {
  let writes = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path === '/api/items') {
      response.setHeader('content-type', 'application/json');
      response.end('{"items":["one"]}');
    } else if (path === '/api/save') {
      writes++;
      response.end('saved');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html>
        <input id="search">
        <button id="load" type="button">Load</button>
        <button id="save" type="button">Save</button>
        <form action="/api/save" method="post"><button id="submit">Submit</button></form>
        <script>
          document.querySelector('#load').addEventListener('click', () =>
            fetch('/api/items?token=request-secret').then(r => r.json()).then(() => {
              document.body.dataset.loaded = 'yes';
            }));
          document.querySelector('#save').addEventListener('click', () =>
            fetch('/api/save?token=write-secret', { method: 'POST' }).catch(() => {}));
        </script>`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.close();
    await once(server, 'close');
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { browser, origin, writes: () => writes };
}

test('state graph redacts private paths and query values', () => {
  assert.equal(sanitizeObservedUrl('https://site.test/users/alice@example.com/orders/123?token=secret#private'),
    'https://site.test/[redacted]/[redacted]/[redacted]/[redacted]');
  assert.equal(sanitizeObservedUrl('https://site.test/docs/getting-started?key=secret'),
    'https://site.test/docs/[redacted]');
  assert.equal(sanitizeObservedUrl('javascript:alert(1)'), '[non-web-url]');
  assert.deepEqual(classifyOperationRequest({ method: () => 'POST', resourceType: () => 'fetch' }), {
    method: 'POST', resourceType: 'fetch', category: 'write-risk',
  });
});

test('state graph records explicit transitions and dependencies without leaking inputs', { timeout: 30_000 }, async t => {
  const { browser, origin, writes } = await fixture(t);
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  const observed = [];
  t.after(() => context.close());
  const report = await exploreOperationStates({
    page,
    onObservedRequest: request => observed.push(request),
    actions: [
      { type: 'navigate', url: `${origin}/?token=navigation-secret` },
      { type: 'fill', selector: '#search', value: 'typed-secret' },
      { type: 'click', selector: '#load' },
      { type: 'click', selector: '#save' },
      { type: 'click', selector: '#after' },
    ],
    settleMs: 100,
  });

  assert.equal(report.states.length, 5);
  assert.equal(report.summary.planned, 5);
  assert.equal(report.summary.executed, 4);
  assert.equal(report.summary.unexecuted, 1);
  assert.deepEqual(report.unexecuted, [{ index: 4, type: 'click', reason: 'write-risk-request' }]);
  assert.deepEqual(report.states[1].viewport, { width: 800, height: 600 });
  assert.deepEqual(report.states.slice(1).map(s => s.action.type), ['navigate', 'fill', 'click', 'click']);
  assert.ok(report.states[1].requests.some(r => r.category === 'document' && r.outcome === 'complete'));
  assert.ok(report.states[3].requests.some(r => r.category === 'dynamic-data' && r.outcome === 'complete'));
  assert.ok(observed.some(r => r.url === `${origin}/api/items?token=request-secret`
    && r.mime === 'application/json' && r.status === 200));
  assert.equal(report.states[3].requests.some(r => Object.hasOwn(r, 'url')), false);
  assert.ok(report.states[4].requests.some(r => r.category === 'write-risk' && r.outcome === 'blocked'));
  assert.equal(report.states[4].result.status, 'blocked');
  assert.equal(writes(), 0);
  assert.doesNotMatch(JSON.stringify(report), /navigation-secret|request-secret|write-secret|typed-secret|#search|#load|#save|token=/);
});

test('state graph enforces action budget, closes owned page and blocks submit controls', { timeout: 30_000 }, async t => {
  const { browser, origin, writes } = await fixture(t);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const limited = await exploreOperationStates({
    context,
    baseUrl: origin,
    actions: [
      { type: 'navigate', url: '/' },
      { type: 'click', selector: '#submit' },
    ],
    maxActions: 1,
    settleMs: 0,
  });
  assert.equal(limited.summary.executed, 1);
  assert.deepEqual(limited.unexecuted, [{ index: 1, type: 'click', reason: 'action-budget' }]);
  assert.equal(context.pages().length, 0);

  const blocked = await exploreOperationStates({
    context,
    baseUrl: origin,
    actions: [
      { type: 'navigate', url: '/' },
      { type: 'click', selector: '#submit' },
    ],
    settleMs: 0,
  });
  assert.equal(blocked.states[2].result.reason, 'submit-control');
  assert.equal(writes(), 0);
  assert.equal(context.pages().length, 0);
});

test('one relative operation script replays against two independently hosted origins', { timeout: 30_000 }, async t => {
  const source = await fixture(t);
  const clone = await fixture(t);
  const actions = [
    { type: 'navigate', url: '/products?token=replay-secret' },
    { type: 'click', selector: '#load' },
  ];
  const sourceContext = await source.browser.newContext({ serviceWorkers: 'block' });
  const cloneContext = await clone.browser.newContext({ serviceWorkers: 'block', viewport: null });
  t.after(async () => { await sourceContext.close(); await cloneContext.close(); });

  const first = await exploreOperationStates({ context: sourceContext, baseUrl: source.origin, actions, settleMs: 100 });
  const second = await exploreOperationStates({ context: cloneContext, baseUrl: clone.origin, actions, settleMs: 100 });
  assert.equal(first.states[2].result.status, 'ok');
  assert.equal(second.states[2].result.status, 'ok');
  assert.equal(first.states[1].url, `${source.origin}/products`);
  assert.equal(second.states[1].url, `${clone.origin}/products`);
  assert.ok(second.states[1].viewport.width > 0 && second.states[1].viewport.height > 0);
  assert.ok(first.states[2].requests.some(r => r.category === 'dynamic-data'));
  assert.ok(second.states[2].requests.some(r => r.category === 'dynamic-data'));
  assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(second), /replay-secret|token=/);
});

test('an explicitly permitted write is classified and recorded', { timeout: 30_000 }, async t => {
  const { browser, origin, writes } = await fixture(t);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const report = await exploreOperationStates({
    context,
    baseUrl: origin,
    actions: [
      { type: 'navigate', url: '/' },
      { type: 'click', selector: '#save' },
    ],
    allowUnsafeRequests: true,
    settleMs: 100,
  });
  assert.equal(report.states[2].result.status, 'ok');
  assert.ok(report.states[2].requests.some(r => r.category === 'write-risk' && r.outcome === 'complete'));
  assert.equal(writes(), 1);
});
