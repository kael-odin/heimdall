import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { captureSourceOperations } from '../src/crawler/source-operations.mjs';
import {
  addReadOnlyFlowEvidence, compareReadOnlyFlowEvidence, observeReadOnlyPage, sourceReadDataCollector,
} from '../src/crawler/source-read-data.mjs';
import { isReplayableReadOnlyDataEntry } from '../src/live/har.mjs';

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
    if (path === '/popup-readonly') {
      return response.end(`<script>fetch('/api/items?token=popup-read-secret')
        .then(() => { window.opener.document.querySelector('#popup-done').hidden = false; });</script>`);
    }
    if (path === '/secure') {
      return response.end(`<!doctype html><div id="allowed" hidden>Authorized</div><script>
        if (document.cookie.includes('auth=secret-cookie') && sessionStorage.getItem('gate') === 'session-secret')
          document.querySelector('#allowed').hidden = false;
      </script>`);
    }
    if (path === '/late') {
      return response.end(`<!doctype html><button id="late" type="button">Late</button>
        <script>document.querySelector('#late').onclick = () =>
          setTimeout(() => fetch('/api/items?token=late-secret'), 150);</script>`);
    }
    return response.end(`<!doctype html>
      <input id="secret"><button id="load" type="button">Load</button>
      <button id="write" type="button">Write</button>
      <button id="popup" type="button">Popup</button>
      <button id="popup-read" type="button">Read in popup</button>
      <form action="/api/save" method="post"><button id="submit">Submit</button></form>
      <span id="done" hidden>Loaded</span><span id="popup-done" hidden>Opened</span>
      <script>
        document.querySelector('#load').onclick = () => fetch('/api/items?token=request-secret')
          .then(r => r.json()).then(() => { document.querySelector('#done').hidden = false; });
        document.querySelector('#write').onclick = () => fetch('/api/save?token=write-secret', { method: 'POST' }).catch(() => {});
        document.querySelector('#popup').onclick = () => window.open('/popup');
        document.querySelector('#popup-read').onclick = () => window.open('/popup-readonly');
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

test('source capture fails closed when a request starts after the final state', { timeout: 30_000 }, async t => {
  const { origin } = await fixture(t);
  const report = await captureSourceOperations({
    origin,
    flows: [{ path: '/late', actions: [{ type: 'click', selector: '#late' }],
      expect: [{ type: 'visible', selector: '#late' }] }],
    settleMs: 50,
    lateMs: 300,
  });
  assert.equal(report.failed, 1);
  assert.ok(report.flows[0].issues.some(issue => issue.kind === 'lateRequests' && issue.count === 1));
  assert.doesNotMatch(JSON.stringify(report), /late-secret|#late|token=/);
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
  assert.ok(report.flows[2].issues.some(item => item.kind === 'popupUntested'));
  assert.doesNotMatch(JSON.stringify(report), /write-secret|popup-secret|#write|#submit|#popup/);
});

test('a read-only popup is not silently treated as a fully observed source flow', { timeout: 30_000 }, async t => {
  const { origin, writes } = await fixture(t);
  const report = await captureSourceOperations({
    origin,
    flows: [{ path: '/', actions: [{ type: 'click', selector: '#popup-read' }],
      expect: [{ type: 'visible', selector: '#popup-done' }] }],
    settleMs: 250,
  });
  assert.equal(writes(), 0);
  assert.equal(report.checked, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.flows[0].passed, false);
  assert.ok(report.flows[0].issues.some(item => item.kind === 'popupUntested'));
  assert.equal(report.flows[0].assertions[0].status, 'untested');
  assert.doesNotMatch(JSON.stringify(report), /popup-read-secret|#popup-read|#popup-done|token=/);
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

test('source capture separates named sessions per flow and fails closed on missing sessions', { timeout: 30_000 }, async t => {
  const { origin } = await fixture(t);
  const cookie = (name, value) => ({
    name, value, domain: '127.0.0.1', path: '/', expires: -1,
    httpOnly: false, secure: false, sameSite: 'Lax',
  });
  const session = (name, value) => ({
    cookies: [cookie('auth', name)],
    origins: [],
    sessionStorage: [{ origin, entries: [{ name: 'gate', value }] }],
  });
  const admin = session('secret-cookie', 'session-secret');
  const guest = session('guest-cookie-secret', 'guest-gate-secret');
  const flows = ['admin', 'guest', 'missing'].map(name => ({
    path: '/secure', sessionName: name,
    actions: [], expect: [{ type: 'visible', selector: '#allowed' }],
  }));
  const report = await captureSourceOperations({
    origin, flows,
    sessions: { admin, guest },
    settleMs: 50,
    // admin 这条要求断言"通过"：页面脚本先读 cookie 与 sessionStorage 再显示 #allowed。
    // 100ms 在本机够用，在满载的 CI 机器上会偶发超时（2026-10-24 CI 实测 admin 判 failed）。
    // 通过型断言给足 1s；失败型断言（guest / missing）本来就该失败，超时长短不改变结论。
    assertionTimeoutMs: 1000,
  });

  assert.equal(report.sessionUsed, true);
  assert.equal(report.flows[0].sessionName, 'admin');
  assert.equal(report.flows[0].sessionUsed, true);
  assert.equal(report.flows[0].passed, true, JSON.stringify(report.flows[0]));
  assert.equal(report.flows[1].sessionName, 'guest');
  assert.equal(report.flows[1].sessionUsed, true);
  assert.equal(report.flows[1].passed, false);
  assert.equal(report.flows[2].sessionName, 'missing');
  assert.equal(report.flows[2].sessionUsed, false);
  assert.ok(report.flows[2].issues.some(issue => issue.kind === 'sessionMissing' && issue.sessionName === 'missing'));
  assert.equal(report.failed, 2);
  assert.doesNotMatch(JSON.stringify(report), /secret-cookie|session-secret|admin-cookie-secret|admin-gate-secret|guest-cookie-secret|guest-gate-secret|auth=|#allowed/);
});

test('source capture switches sessions inside one flow and fails closed on missing switches', { timeout: 30_000 }, async t => {
  const { origin } = await fixture(t);
  const cookie = (name, value) => ({
    name, value, domain: '127.0.0.1', path: '/', expires: -1,
    httpOnly: false, secure: false, sameSite: 'Lax',
  });
  const session = (name, value) => ({
    cookies: [cookie('auth', name)],
    origins: [],
    sessionStorage: [{ origin, entries: [{ name: 'gate', value }] }],
  });
  const admin = session('admin-cookie-secret', 'admin-gate-secret');
  const guest = session('guest-cookie-secret', 'guest-gate-secret');
  const report = await captureSourceOperations({
    origin,
    flows: [{
      path: '/secure', sessionName: 'admin',
      actions: [{ type: 'useSession', sessionName: 'guest' }],
      expect: [{ type: 'visible', selector: '#allowed' }],
    }],
    sessions: { admin, guest },
    settleMs: 50,
    assertionTimeoutMs: 100,
  });

  assert.equal(report.failed, 1);
  assert.equal(report.flows[0].sessionName, 'admin');
  assert.equal(report.flows[0].sessionUsed, true);
  assert.deepEqual(report.flows[0].sessionSwitches, [{
    actionIndex: 1, sessionName: 'guest', sessionUsed: true,
  }]);
  assert.equal(report.flows[0].assertions[0].status, 'failed');

  const missing = await captureSourceOperations({
    origin,
    flows: [{
      path: '/secure', sessionName: 'admin',
      actions: [{ type: 'useSession', sessionName: 'missing' }],
      expect: [{ type: 'visible', selector: '#allowed' }],
    }],
    sessions: { admin },
    settleMs: 50,
    assertionTimeoutMs: 100,
  });
  assert.equal(missing.failed, 1);
  assert.ok(missing.flows[0].issues.some(issue => issue.kind === 'sessionMissing' && issue.sessionName === 'missing'));
  assert.equal(missing.flows[0].sessionSwitches[0].sessionUsed, false);
  assert.doesNotMatch(JSON.stringify(report) + JSON.stringify(missing), /admin-cookie-secret|admin-gate-secret|guest-cookie-secret|guest-gate-secret|auth=|#allowed/);
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

async function readDataFixture(t) {
  const huge = 'x'.repeat(1024 * 1024 + 1);
  let version = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/api/public') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"items":["public-marker"]}');
    }
    if (url.pathname === '/api/private') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"email":"alice@example.com"}');
    }
    if (url.pathname === '/api/huge') {
      response.setHeader('content-type', 'text/plain');
      response.setHeader('content-length', Buffer.byteLength(huge));
      return response.end(huge);
    }
    if (url.pathname === '/api/ignored') {
      response.setHeader('content-type', 'application/json');
      return response.end('{"items":["ignored-marker"]}');
    }
    if (url.pathname === '/api/change') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ version: ++version }));
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><button id="load">Load</button><button id="change">Change</button>
      <span id="done" hidden>Done</span><span id="count"></span>
      <script>document.querySelector('#load').onclick = async () => {
        await Promise.all(['/api/public?page=2', '/api/private', '/api/huge', '/api/ignored']
          .map(path => fetch(path).then(response => response.text())));
        document.querySelector('#done').hidden = false;
      };
      document.querySelector('#change').onclick = async () => {
        const data = await fetch('/api/change').then(response => response.json());
        document.querySelector('#count').textContent = String(data.version);
      };</script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('source operations capture only approved dynamic GET data after sanitizing it', { timeout: 30_000 }, async t => {
  const origin = await readDataFixture(t);
  const entries = [];
  const report = await captureSourceOperations({
    origin,
    flows: [{ path: '/', actions: [{ type: 'click', selector: '#load' }],
      expect: [{ type: 'visible', selector: '#done' }] }],
    readOnlyGetUrls: [origin + '/api/public?page=2', origin + '/api/private', origin + '/api/huge'],
    onReadOnlyData: entry => entries.push(entry),
    settleMs: 100,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, origin + '/api/public?page=2');
  assert.equal(isReplayableReadOnlyDataEntry(entries[0], origin), true);
  assert.deepEqual(entries[0].headers, {});
  assert.deepEqual(JSON.parse(Buffer.from(entries[0].body, 'base64').toString()), { items: ['public-marker'] });
  assert.equal(report.readOnlyData.observed, 3);
  assert.equal(report.readOnlyData.accepted, 1);
  assert.equal(report.readOnlyData.rejected, 1);
  assert.equal(report.readOnlyData.oversized, 1);
  assert.equal(report.readOnlyData.failed, 0);
  assert.equal(report.flows[0].assertions[0].status, 'passed');
  assert.doesNotMatch(JSON.stringify(report), /public-marker|alice@example.com|ignored-marker|"body"|"headers"/);
});

test('source read-only capture rejects credentialed responses and unsafe plans', { timeout: 30_000 }, async t => {
  const origin = await readDataFixture(t);
  const entries = [];
  const session = { cookies: [{ name: 'auth', value: 'session-secret', domain: '127.0.0.1', path: '/',
    expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] };
  const report = await captureSourceOperations({
    origin, session,
    flows: [{ path: '/', actions: [{ type: 'click', selector: '#load' }],
      expect: [{ type: 'visible', selector: '#done' }] }],
    readOnlyGetUrls: [origin + '/api/public?page=2'],
    onReadOnlyData: entry => entries.push(entry),
    settleMs: 100,
  });
  assert.equal(entries.length, 0);
  assert.deepEqual(report.readOnlyData, { observed: 1, accepted: 0, rejected: 1, oversized: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(report), /session-secret|auth=/);
  await assert.rejects(captureSourceOperations({ origin, flows: [],
    readOnlyGetUrls: [origin + '/api/public?access_token=secret'], onReadOnlyData() {} }),
  /unsafe source read-only data URL/);
  await assert.rejects(captureSourceOperations({ origin, flows: [],
    readOnlyGetUrls: [origin + '/api/public?page=2'] }), /invalid source read-only data options/);
});

test('source read-only capture emits changed bodies for the same approved URL', { timeout: 30_000 }, async t => {
  const origin = await readDataFixture(t);
  const entries = [];
  const report = await captureSourceOperations({
    origin,
    flows: [{ path: '/', actions: [
      { type: 'click', selector: '#change' }, { type: 'click', selector: '#change' },
    ], expect: [{ type: 'text-includes', selector: '#count', value: '2' }] }],
    readOnlyGetUrls: [origin + '/api/change'],
    onReadOnlyData: entry => entries.push(entry),
    settleMs: 100,
  });
  assert.deepEqual(entries.map(entry => JSON.parse(Buffer.from(entry.body, 'base64').toString()).version), [1, 2]);
  assert.deepEqual(report.readOnlyData, { observed: 2, accepted: 2, rejected: 0, oversized: 0, failed: 0 });
  assert.equal(report.flows[0].assertions[0].status, 'passed');
});

test('source read-only capture does not refetch an empty script response', { timeout: 30_000 }, async t => {
  let dataRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/public') {
      dataRequests++;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (dataRequests === 1) {
        response.writeHead(204, { 'content-length': '13' });
        return response.end();
      }
      return response.end('{"version":2}');
    }
    response.setHeader('content-type', 'text/html');
    return response.end('<!doctype html><script src="/api/public"></script><div id="ready">Ready</div>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entries = [];
  const report = await captureSourceOperations({
    origin,
    flows: [{ path: '/', actions: [], expect: [{ type: 'visible', selector: '#ready' }] }],
    readOnlyGetUrls: [origin + '/api/public'],
    onReadOnlyData: entry => entries.push(entry),
    settleMs: 100,
  });
  assert.equal(dataRequests, 1, 'observing a response must not send another request');
  assert.equal(entries.length, 0, 'an empty response must not become replayable data');
  assert.notEqual(report.readOnlyData.accepted, 1);
});

function protocolFixture() {
  const session = new EventEmitter();
  const context = new EventEmitter();
  const calls = [];
  const bodies = new Map();
  session.send = async (method, options) => {
    calls.push({ method, options });
    if (method === 'Network.getResponseBody') return { body: bodies.get(options.requestId), base64Encoded: false };
    return {};
  };
  session.detach = async () => {};
  context.newCDPSession = async () => session;
  return { session, context, page: { context: () => context }, calls, bodies };
}

test('read-only CDP capture binds concurrent responses by request id and accepts reordered headers', async () => {
  const { session, context, page, calls, bodies } = protocolFixture();
  const url = 'https://source.test/api/public';
  const entries = [];
  const collector = sourceReadDataCollector({ origin: 'https://source.test', urls: [url], onEntry: entry => entries.push(entry) });
  const observer = await observeReadOnlyPage(page, { collector, urls: ['HTTPS://SOURCE.TEST:443/api/public'], flowIndex: 0 });
  for (const id of ['first', 'second']) {
    session.emit('Network.requestWillBeSentExtraInfo', { requestId: id, headers: { accept: 'application/json' } });
    session.emit('Network.requestWillBeSent', { requestId: id, request: { method: 'GET', url, headers: {} } });
    session.emit('Network.responseReceivedExtraInfo', { requestId: id, statusCode: 200, headers: { 'Content-Type': 'application/json' } });
    session.emit('Network.responseReceived', { requestId: id, hasExtraInfo: true, response: { url, status: 200, headers: {} } });
    context.emit('response', { url: () => url, request: () => ({ method: () => 'GET' }) });
  }
  bodies.set('first', '{"version":1}');
  bodies.set('second', '{"version":2}');
  session.emit('Network.loadingFinished', { requestId: 'second' });
  session.emit('Network.loadingFinished', { requestId: 'first' });
  await observer.close();
  assert.deepEqual(entries.map(entry => JSON.parse(Buffer.from(entry.body, 'base64').toString()).version), [2, 1]);
  assert.deepEqual(calls.filter(call => call.method === 'Network.getResponseBody').map(call => call.options.requestId), ['second', 'first']);
  assert.deepEqual(collector.summary(), { observed: 2, accepted: 2, rejected: 0, oversized: 0, failed: 0 });
});

test('read-only CDP capture fails closed when provenance or an observation is missing', async () => {
  const { session, context, page, calls } = protocolFixture();
  const url = 'https://source.test/api/public';
  const entries = [];
  const collector = sourceReadDataCollector({ origin: 'https://source.test', urls: [url], onEntry: entry => entries.push(entry) });
  const observer = await observeReadOnlyPage(page, { collector, urls: [url], flowIndex: 0 });
  session.emit('Network.requestWillBeSent', { requestId: 'without-headers', request: { method: 'GET', url, headers: {} } });
  session.emit('Network.responseReceived', { requestId: 'without-headers', hasExtraInfo: false, response: { url, status: 200, headers: {} } });
  context.emit('response', { url: () => url, request: () => ({ method: () => 'GET' }) });
  session.emit('Network.loadingFinished', { requestId: 'without-headers' });
  context.emit('response', { url: () => url, request: () => ({ method: () => 'GET' }) });
  await observer.close();
  assert.equal(entries.length, 0);
  assert.equal(calls.filter(call => call.method === 'Network.getResponseBody').length, 0);
  assert.deepEqual(collector.summary(), { observed: 2, accepted: 0, rejected: 0, oversized: 0, failed: 2 });
});

test('read-only CDP capture fails closed when protocol tracking exceeds its limit', async () => {
  const { session, page } = protocolFixture();
  const url = 'https://source.test/api/public';
  const collector = sourceReadDataCollector({ origin: 'https://source.test', urls: [url], onEntry() {} });
  const observer = await observeReadOnlyPage(page, { collector, urls: [url], flowIndex: 0 });
  for (let index = 0; index < 801; index++) {
    session.emit('Network.requestWillBeSentExtraInfo', { requestId: String(index), headers: {} });
  }
  await observer.close();
  assert.deepEqual(collector.summary(), { observed: 0, accepted: 0, rejected: 0, oversized: 0, failed: 1 });
});

test('read-only CDP capture rejects private headers from either protocol event', async () => {
  const { session, context, page, bodies } = protocolFixture();
  const url = 'https://source.test/api/public';
  const entries = [];
  const collector = sourceReadDataCollector({ origin: 'https://source.test', urls: [url], onEntry: entry => entries.push(entry) });
  const observer = await observeReadOnlyPage(page, { collector, urls: [url], flowIndex: 0 });
  const cases = [
    { id: 'cookie', requestExtra: { Cookie: 'fixture-private-cookie' } },
    { id: 'set-cookie', responseExtra: { 'Set-Cookie': 'fixture-private-cookie' } },
    { id: 'vary', responseHeaders: { Vary: 'Cookie' }, responseExtra: { Vary: 'Accept' } },
    { id: 'cache', responseHeaders: { 'Cache-Control': 'private' }, responseExtra: { 'Cache-Control': 'public' } },
  ];
  for (const item of cases) {
    session.emit('Network.requestWillBeSent', { requestId: item.id, request: { method: 'GET', url, headers: {} } });
    session.emit('Network.requestWillBeSentExtraInfo', { requestId: item.id, headers: item.requestExtra ?? {} });
    session.emit('Network.responseReceived', { requestId: item.id, hasExtraInfo: true,
      response: { url, status: 200, headers: { 'Content-Type': 'application/json', ...item.responseHeaders } } });
    session.emit('Network.responseReceivedExtraInfo', { requestId: item.id, statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...item.responseExtra } });
    context.emit('response', { url: () => url, request: () => ({ method: () => 'GET' }) });
    bodies.set(item.id, '{"items":["public"]}');
    session.emit('Network.loadingFinished', { requestId: item.id });
  }
  await observer.close();
  assert.deepEqual(entries, []);
  assert.deepEqual(collector.summary(), { observed: 4, accepted: 0, rejected: 4, oversized: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(collector.summary()), /fixture-private-cookie/);
});

test('read-only CDP capture rejects cached, redirected and inconsistent responses', async () => {
  const { session, context, page, calls } = protocolFixture();
  const url = 'https://source.test/api/public';
  const entries = [];
  const collector = sourceReadDataCollector({ origin: 'https://source.test', urls: [url], onEntry: entry => entries.push(entry) });
  const observer = await observeReadOnlyPage(page, { collector, urls: [url], flowIndex: 0 });
  for (const id of ['cached', 'redirected', 'different-url', 'different-status']) {
    session.emit('Network.requestWillBeSent', { requestId: id, request: { method: 'GET', url, headers: {} } });
    if (id === 'redirected') {
      session.emit('Network.requestWillBeSent', { requestId: id, redirectResponse: { status: 302 }, request: { method: 'GET', url, headers: {} } });
    }
    session.emit('Network.requestWillBeSentExtraInfo', { requestId: id, headers: {} });
    session.emit('Network.responseReceived', { requestId: id, hasExtraInfo: true,
      response: { url: id === 'different-url' ? url + '-other' : url, status: 200, headers: {}, fromDiskCache: id === 'cached' } });
    session.emit('Network.responseReceivedExtraInfo', { requestId: id, statusCode: id === 'different-status' ? 304 : 200,
      headers: { 'Content-Type': 'application/json' } });
    context.emit('response', { url: () => url, request: () => ({ method: () => 'GET' }) });
    session.emit('Network.loadingFinished', { requestId: id });
  }
  await observer.close();
  assert.deepEqual(entries, []);
  assert.equal(calls.filter(call => call.method === 'Network.getResponseBody').length, 0);
  assert.deepEqual(collector.summary(), { observed: 4, accepted: 0, rejected: 0, oversized: 0, failed: 4 });
});

test('read-only flow comparison distinguishes per-flow URLs and sanitized response changes', () => {
  const first = 'https://source.test/api/list?page=1';
  const second = 'https://source.test/api/list?page=2';
  const entry = (url, status, mimeType, body) => ({
    url, status, mimeType, body: Buffer.from(body).toString('base64'),
  });
  const source = new Map();
  addReadOnlyFlowEvidence(source, 0, entry(first, 200, 'application/json; charset=utf-8', '{"items":[1]}'));
  addReadOnlyFlowEvidence(source, 1, entry(second, 200, 'application/json; charset=utf-8', '{"items":[2]}'));
  const swapped = new Map();
  addReadOnlyFlowEvidence(swapped, 0, entry(second, 200, 'application/json; charset=utf-8', '{"items":[2]}'));
  addReadOnlyFlowEvidence(swapped, 1, entry(first, 200, 'application/json; charset=utf-8', '{"items":[1]}'));
  const swappedReport = compareReadOnlyFlowEvidence(source, swapped, 2);
  assert.equal(swappedReport.mismatchedFlows, 2);
  assert.equal(swappedReport.missing, 2);
  assert.equal(swappedReport.unexpected, 2);
  assert.doesNotMatch(JSON.stringify(swappedReport), /\/api\/list|items|[a-f0-9]{64}/);

  const changed = new Map();
  addReadOnlyFlowEvidence(changed, 0, entry(first, 201, 'text/plain; charset=utf-8', 'changed'));
  addReadOnlyFlowEvidence(changed, 1, entry(second, 200, 'application/json; charset=utf-8', '{"items":[2]}'));
  const changedReport = compareReadOnlyFlowEvidence(source, changed, 2);
  assert.equal(changedReport.responseMismatch, 1);
  assert.equal(changedReport.statusMismatch, 1);
  assert.equal(changedReport.mimeMismatch, 1);
  assert.equal(changedReport.bodyMismatch, 1);
  assert.equal(changedReport.matchedFlows, 1);
});

test('deduplicated public GET still records evidence for every flow that observed it', async () => {
  const origin = 'https://source.test';
  const url = origin + '/api/public';
  const delivered = [];
  const observedFlows = [];
  const collector = sourceReadDataCollector({
    origin, urls: [url], onEntry: entry => delivered.push(entry),
    onAccepted: (_entry, flowIndex) => observedFlows.push(flowIndex),
  });
  const response = () => ({
    url: () => url, status: () => 200,
    request: () => ({ method: () => 'GET', allHeaders: async () => ({}), postData: () => null }),
    allHeaders: async () => ({ 'content-type': 'application/json' }),
    body: async () => Buffer.from('{"items":["public"]}'),
  });
  collector.observe(response(), 0);
  await collector.drain();
  collector.observe(response(), 1);
  await collector.drain();
  assert.equal(delivered.length, 1);
  assert.deepEqual(observedFlows, [0, 1]);
  assert.equal(collector.summary().accepted, 2);
});

test('source read-only capture bounds approved URLs and cumulative delivered bytes', async () => {
  const origin = 'https://source.test';
  const urls = Array.from({ length: 11 }, (_, index) => origin + '/api/data-' + index);
  const delivered = [];
  const collector = sourceReadDataCollector({ origin, urls, onEntry: entry => delivered.push(entry) });
  const body = Buffer.from('public '.repeat(149_796));
  for (const url of urls) {
    const request = { method: () => 'GET', allHeaders: async () => ({}), postData: () => null };
    collector.observe({
      url: () => url, status: () => 200, request: () => request,
      allHeaders: async () => ({ 'content-type': 'text/plain', 'content-length': String(body.length) }),
      body: async () => body,
    });
  }
  await collector.drain();
  assert.equal(delivered.length, 10);
  assert.deepEqual(collector.summary(), { observed: 11, accepted: 10, rejected: 0, oversized: 1, failed: 0 });
  assert.throws(() => sourceReadDataCollector({ origin,
    urls: Array.from({ length: 101 }, (_, index) => origin + '/api/data-' + index), onEntry() {} }),
  /invalid source read-only data options/);
});

test('source read-only capture accepts a long public text body within the byte limit', async () => {
  const origin = 'https://source.test';
  const url = origin + '/api/long';
  const delivered = [];
  const collector = sourceReadDataCollector({ origin, urls: [url], onEntry: entry => delivered.push(entry) });
  const body = Buffer.from('x'.repeat(800_000));
  const request = { method: () => 'GET', allHeaders: async () => ({}), postData: () => null };
  collector.observe({
    url: () => url, status: () => 200, request: () => request,
    allHeaders: async () => ({ 'content-type': 'text/plain', 'content-length': String(body.length) }),
    body: async () => body,
  });
  await collector.drain();
  assert.equal(delivered.length, 1);
  assert.equal(Buffer.from(delivered[0].body, 'base64').length, body.length);
  assert.deepEqual(collector.summary(), { observed: 1, accepted: 1, rejected: 0, oversized: 0, failed: 0 });
});

test('source read-only capture bounds a queue of hanging bodies by one deadline', async () => {
  const origin = 'https://source.test';
  const url = origin + '/api/slow';
  const delivered = [];
  let releaseBody;
  const body = new Promise(resolve => { releaseBody = resolve; });
  const collector = sourceReadDataCollector({ origin, urls: [url],
    onEntry: entry => delivered.push(entry), captureTimeoutMs: 40 });
  const request = { method: () => 'GET', allHeaders: async () => ({}), postData: () => null };
  for (let index = 0; index < 8; index++) {
    collector.observe({
      url: () => url, status: () => 200, request: () => request,
      allHeaders: async () => ({ 'content-type': 'application/json' }),
      body: () => body,
    });
  }
  const started = Date.now();
  await collector.drain();
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(collector.summary(), { observed: 8, accepted: 0, rejected: 0, oversized: 0, failed: 8 });
  releaseBody(Buffer.from('{"items":["public"]}'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delivered.length, 0);
  assert.equal(collector.summary().failed, 8);
});
