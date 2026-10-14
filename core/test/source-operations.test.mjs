import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { captureSourceOperations } from '../src/crawler/source-operations.mjs';
import {
  addReadOnlyFlowEvidence, compareReadOnlyFlowEvidence, sourceReadDataCollector,
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
