import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { captureSourceOperations } from '../src/crawler/source-operations.mjs';

async function fixture(t) {
  let writes = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path === '/api/items') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"items":["one"]}');
    }
    if (path === '/api/save') {
      writes++;
      return response.end('saved');
    }
    response.setHeader('content-type', 'text/html');
    if (path === '/popup') {
      return response.end(`<script>fetch('/api/save?token=popup-secret', {method:'POST'})
        .catch(() => {}).finally(() => { window.opener.document.querySelector('#popup-done').hidden = false; });</script>`);
    }
    if (path === '/secure') {
      return response.end(`<!doctype html><div id="allowed" hidden>Authorized</div><script>
        if (document.cookie.includes('auth=secret-cookie') && sessionStorage.getItem('gate') === 'session-secret')
          document.querySelector('#allowed').hidden = false;
      </script>`);
    }
    return response.end(`<!doctype html>
      <input id="secret"><button id="load" type="button">Load</button>
      <button id="write" type="button">Write</button>
      <button id="popup" type="button">Popup</button>
      <form action="/api/save" method="post"><button id="submit">Submit</button></form>
      <span id="done" hidden>Loaded</span><span id="popup-done" hidden>Opened</span>
      <script>
        document.querySelector('#load').onclick = () => fetch('/api/items?token=request-secret')
          .then(r => r.json()).then(() => { document.querySelector('#done').hidden = false; });
        document.querySelector('#write').onclick = () => fetch('/api/save?token=write-secret', { method: 'POST' }).catch(() => {});
        document.querySelector('#popup').onclick = () => window.open('/popup');
      </script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, writes: () => writes };
}

test('source capture returns redacted per-step states, dependencies and assertions', { timeout: 30_000 }, async t => {
  const { origin, writes } = await fixture(t);
  const report = await captureSourceOperations({
    origin,
    flows: [{
      path: '/?token=navigation-secret',
      actions: [
        { type: 'fill', selector: '#secret', value: 'typed-secret' },
        { type: 'click', selector: '#load' },
      ],
      expect: [{ type: 'visible', selector: '#done' }, { type: 'text-includes', selector: '#done', value: 'Loaded' }],
    }],
    settleMs: 100,
  });
  assert.equal(report.checked, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.untested, 0);
  assert.equal(report.flows[0].passed, true);
  assert.equal(report.flows[0].states.length, 4);
  assert.equal(report.flows[0].plannedActions, 3);
  assert.deepEqual(report.flows[0].assertions.map(item => item.status), ['passed', 'passed']);
  assert.ok(report.flows[0].dependencies.some(item => item.category === 'dynamic-data' && item.outcome === 'complete'));
  assert.equal(writes(), 0);
  assert.doesNotMatch(JSON.stringify(report), /navigation-secret|request-secret|typed-secret|#secret|#load|#done|token=/);
});

test('source capture blocks page and popup writes, and marks later actions and assertions untested', { timeout: 30_000 }, async t => {
  const { origin, writes } = await fixture(t);
  const report = await captureSourceOperations({
    origin,
    flows: [
      { path: '/', actions: [{ type: 'click', selector: '#write' }, { type: 'click', selector: '#load' }],
        expect: [{ type: 'visible', selector: '#done' }] },
      { path: '/', actions: [{ type: 'click', selector: '#submit' }],
        expect: [{ type: 'visible', selector: '#done' }] },
      { path: '/', actions: [{ type: 'click', selector: '#popup' }],
        expect: [{ type: 'visible', selector: '#popup-done' }] },
    ],
    settleMs: 300,
  });
  assert.equal(writes(), 0);
  assert.equal(report.failed, 3);
  assert.equal(report.flows[0].unexecutedActions.length, 1);
  assert.equal(report.flows[0].assertions[0].status, 'untested');
  assert.ok(report.flows[0].issues.some(item => item.kind === 'action' && item.result === 'blocked'));
  assert.ok(report.flows[1].issues.some(item => item.kind === 'action' && item.result === 'blocked'));
  assert.ok(report.flows[2].issues.some(item => item.kind === 'writeBlocked'));
  assert.doesNotMatch(JSON.stringify(report), /write-secret|popup-secret|#write|#submit|#popup/);
});

test('source capture can use authorized cookie and sessionStorage without reporting their values', { timeout: 30_000 }, async t => {
  const { origin } = await fixture(t);
  const flow = { path: '/secure', actions: [], expect: [{ type: 'visible', selector: '#allowed' }] };
  const denied = await captureSourceOperations({ origin, flows: [flow], settleMs: 50, assertionTimeoutMs: 100 });
  assert.equal(denied.failed, 1);
  assert.equal(denied.flows[0].assertions[0].status, 'failed');

  const session = {
    cookies: [{ name: 'auth', value: 'secret-cookie', domain: '127.0.0.1', path: '/', expires: -1,
      httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [{ origin, localStorage: [{ name: 'private-local', value: 'local-secret' }] }],
    sessionStorage: [{ origin, entries: [{ name: 'gate', value: 'session-secret' }] }],
  };
  const allowed = await captureSourceOperations({ origin, flows: [flow], session, settleMs: 50 });
  assert.equal(allowed.failed, 0);
  assert.equal(allowed.sessionUsed, true);
  assert.equal(allowed.flows[0].assertions[0].status, 'passed');
  assert.doesNotMatch(JSON.stringify(allowed), /secret-cookie|session-secret|local-secret|private-local|#allowed/);
});

test('source capture rejects malformed flow and session before opening a browser', async () => {
  await assert.rejects(captureSourceOperations({ origin: 'https://site.test/private', flows: [] }), /invalid source origin/);
  await assert.rejects(captureSourceOperations({ origin: 'https://site.test', flows: [{ path: '//foreign.test', actions: [], expect: [] }] }), /invalid source flow/);
  await assert.rejects(captureSourceOperations({ origin: 'https://site.test', flows: [], session: 'session.json' }), /invalid source session/);
});

test('source capture reports all actions and assertions as untested when context creation fails', async () => {
  const report = await captureSourceOperations({
    origin: 'https://site.test',
    flows: [{ path: '/private?token=start-secret', actions: [{ type: 'click', selector: '#private-selector' }],
      expect: [{ type: 'visible', selector: '#secret-result' }] }],
    browser: { newContext: async () => { throw new Error('browser-secret'); } },
  });
  assert.equal(report.failed, 1);
  assert.equal(report.flows[0].executedActions, 0);
  assert.deepEqual(report.flows[0].unexecutedActions.map(item => item.type), ['navigate', 'click']);
  assert.equal(report.flows[0].assertions[0].status, 'untested');
  assert.ok(report.flows[0].issues.some(item => item.kind === 'captureError'));
  assert.doesNotMatch(JSON.stringify(report), /start-secret|private-selector|secret-result|browser-secret/);
});
