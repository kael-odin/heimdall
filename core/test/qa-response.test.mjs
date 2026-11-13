import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { invoke } from '../src/agent/registry/invoke.mjs';
import { normalizeCheck } from '../src/qa/probe.mjs';
import { observeResponses } from '../src/qa/response-check.mjs';
import { runQa } from '../src/qa/run.mjs';
import { loadWorkspace } from '../src/qa/workspace.mjs';

const PRIVATE = 'fixture-private-value-do-not-record';
const cases = ['ok', 'ok-get', 'string-code', 'null-field', 'status-only', 'bad-code', 'bad-http', 'wrong-type',
  'missing-field', 'nonscalar', 'not-json', 'duplicate', 'missing', 'blocked', 'oversize', 'compressed', 'invalid-json', 'query', 'iframe',
  'redirect-in', 'empty-query'];
const QUERY_MARKER = 'public-query-value-do-not-record';
const GET_CASES = new Set(['ok-get', 'redirect-in', 'approved-query', 'reordered-query', 'empty-value-query', 'wrong-query', 'extra-query', 'repeated-query', 'empty-separators-query']);

function startServer() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://example.invalid');
    if (url.pathname === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>blank</title><h1>blank</h1>');
    }
    if (url.pathname.startsWith('/page/')) {
      const name = url.pathname.slice('/page/'.length);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (name === 'iframe') return res.end('<!doctype html><title>fixture</title><iframe src="/frame"></iframe>');
      const count = name === 'missing' ? 0 : name === 'duplicate' ? 2 : 1;
      const query = name === 'approved-query' ? `?page=2&q=${QUERY_MARKER}` : name === 'reordered-query' ? `?q=${QUERY_MARKER}&page=2`
        : name === 'empty-value-query' ? '?q=' : name === 'wrong-query' ? '?page=3' : name === 'extra-query' ? '?page=2&extra=1' : name === 'repeated-query' ? '?page=2&page=2'
          : name === 'query' ? '?different=1' : name === 'empty-query' ? '?' : name === 'empty-separators-query' ? '?&&' : '';
      const path = name === 'redirect-in' ? '/redirect-in' : `/api/${name}${query}`;
      return res.end(`<!doctype html><title>fixture</title><div id="ready">ready</div><script>
        let left = ${count};
        for (let i = 0; i < ${count}; i++) {
          const xhr = new XMLHttpRequest(); xhr.open(${JSON.stringify(GET_CASES.has(name) ? 'GET' : 'POST')}, ${JSON.stringify(path)});
          xhr.onloadend = () => { if (!--left) document.querySelector('#ready').dataset.done = '1'; };
          xhr.send('{}');
        }
      </script>`);
    }
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<script>fetch("/api/iframe", {method:"POST"})</script>');
    }
    if (url.pathname === '/redirect-in') {
      res.writeHead(302, { location: '/api/redirect-in' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      hits.push({ path: url.pathname, method: req.method });
      const name = url.pathname.slice('/api/'.length);
      const code = name === 'bad-code' ? 401 : ['wrong-type', 'string-code'].includes(name) ? '0'
        : name === 'null-field' ? null : name === 'nonscalar' ? { nested: true } : 0;
      const payload = name === 'invalid-json' ? '{bad' : name === 'status-only' ? PRIVATE.repeat(30000)
        : JSON.stringify({ ...(name === 'missing-field' ? {} : { code }), count: 2, private: PRIVATE,
          ...(name === 'oversize' ? { padding: 'x'.repeat(300_000) } : {}) });
      if (name === 'compressed') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(gzipSync(payload));
      }
      res.writeHead(name === 'bad-http' ? 401 : 200, { 'content-type': ['not-json', 'status-only'].includes(name) ? 'text/plain' : 'application/json' });
      res.write(payload.slice(0, 8));
      return setTimeout(() => res.end(payload.slice(8)), 20);
    }
    res.writeHead(404); return res.end();
  });
  server.hits = hits;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function workspace(origin) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-response-'));
  mkdirSync(join(root, '.heimdall'));
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({ project: 'response fixture',
    sites: { web: { url: origin, pages: ['/blank'], environment: 'test',
      writes: { allow: cases.filter(name => name !== 'blocked').map(name => ({ method: 'POST', origin, path: `/api/${name}` })) } } },
    defaults: { settleMs: 100, timeoutMs: 5000 } }));
  return root;
}

function check(origin, name) {
  return { id: name, title: `response ${name}`, path: `/page/${name}`,
    ...(name === 'missing' || name === 'iframe' ? {} : { steps: [{ action: 'waitFor', selector: '#ready[data-done]' }] }),
    expect: [{ kind: 'title', equals: 'fixture' }],
    responses: [{ method: GET_CASES.has(name) ? 'GET' : 'POST', origin, path: `/api/${name}`, status: 200,
      ...(['approved-query', 'reordered-query'].includes(name) ? { query: { page: '2', q: QUERY_MARKER } }
        : name === 'empty-value-query' ? { query: { q: '' } } : ['wrong-query', 'extra-query', 'repeated-query'].includes(name) ? { query: { page: '2' } } : {}),
      ...(name === 'status-only' ? {} : { json: ['ok', 'wrong-type', 'missing-field'].includes(name)
        ? [{ path: ['count'], equals: 2 }, { path: ['code'], equals: 0 }]
        : { path: ['code'], equals: name === 'string-code' ? '0' : name === 'null-field' ? null : 0 } }) }] };
}

test('response checks reject ambiguous or unsafe declarations', () => {
  const base = { title: 'response', path: '/', expect: [{ kind: 'title', equals: 'fixture' }] };
  const response = { method: 'POST', origin: 'http://127.0.0.1:1234', path: '/api/list', status: 200, json: { path: ['code'], equals: 0 } };
  assert.deepEqual(normalizeCheck({ ...base, responses: [response] }).responses, [response]);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const write = { ...response, method };
    assert.deepEqual(normalizeCheck({ ...base, responses: [write] }).responses, [write]);
    assert.throws(() => normalizeCheck({ ...base, responses: [{ ...write, query: { q: 'public' } }] }), /response/i);
  }
  const multiple = { ...response, json: [response.json, { path: ['total'], equals: 2 }] };
  assert.deepEqual(normalizeCheck({ ...base, responses: [multiple] }).responses, [multiple]);
  for (const value of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.5]) {
    assert.equal(normalizeCheck({ ...base, responses: [{ ...response, json: { path: ['id'], equals: value } }] }).responses[0].json.equals, value);
  }
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1]) {
    assert.throws(() => normalizeCheck({ ...base, responses: [{ ...response, json: { path: ['id'], equals: value } }] }), /安全整数/);
  }
  for (const invalid of [
    { ...response, origin: 'http://user:pass@127.0.0.1:1234' },
    { ...response, origin: 'http://127.0.0.1:1234/path' },
    { ...response, path: '/api/list?token=secret' },
    { ...response, path: '/api/%2e%2e/list' },
    { ...response, method: 'CONNECT' },
    { ...response, status: null },
    { ...response, json: { path: [], equals: 0 } },
    { ...response, json: { path: Array(1), equals: 0 } },
    { ...response, json: { path: ['code'], equals: { nested: true } } },
    ...[[], [null], [response.json, response.json], Array(1),
      Array.from({ length: 21 }, (_, index) => ({ path: ['field' + index], equals: 0 }))]
      .map(json => ({ ...response, json })),
    { ...response, query: { page: '2' } },
    ...[{}, [], { page: 2 }, { q: '\n' }, { token: PRIVATE }, { q: 'https://other.test/' },
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => ['p' + index, 'x']))]
      .map(query => ({ ...response, method: 'GET', query })),
  ]) assert.throws(() => normalizeCheck({ ...base, responses: [invalid] }), /response/i);
  assert.throws(() => normalizeCheck({ ...base, responses: [response, response] }), /response/i);
  const queried = { ...response, method: 'GET', query: { page: '2', q: 'public' } };
  assert.deepEqual(normalizeCheck({ ...base, responses: [queried] }).responses, [queried]);
  assert.throws(() => normalizeCheck({ ...base, responses: [queried, { ...queried, query: { q: 'public', page: '2' } }] }), /response/i);
});

test('response references require earlier responses and non-overlapping path declarations', () => {
  const source = { method: 'POST', origin: 'http://example.test', path: '/items', status: 201 };
  const reference = { response: 0, path: ['id'] };
  const target = { method: 'GET', origin: source.origin, path: '/items/{itemId}', status: 200,
    pathParams: { itemId: reference }, json: { path: ['id'], equalsFrom: reference } };
  const base = { title: 'Created item', path: '/', expect: [{ kind: 'title', equals: 'fixture' }] };
  assert.deepEqual(normalizeCheck({ ...base, responses: [source, target] }).responses, [source, target]);
  for (const invalid of [
    { ...target, pathParams: undefined }, { ...target, pathParams: {} },
    { ...target, pathParams: { extra: reference } },
    { ...target, path: '/items/pre{itemId}' }, { ...target, path: '/items/{itemId}/{itemId}' },
    ...[-1, 1, 2, 0.5, '0'].map(response => ({ ...target, pathParams: { itemId: { ...reference, response } } })),
    { ...target, json: { path: ['id'], equals: 'hardcoded', equalsFrom: reference } },
    { ...target, json: { path: ['id'], equalsFrom: { ...reference, path: [] } } },
    { ...target, json: { path: ['id'], equalsFrom: { ...reference, response: 1 } } },
  ]) assert.throws(() => normalizeCheck({ ...base, responses: [source, invalid] }), /response/i);
  assert.throws(() => normalizeCheck({ ...base, responses: [source, target, { ...target, path: '/items/known', pathParams: undefined }] }), /response/i);
});

test('response bindings survive delayed CDP body reads and keep values out of results', async () => {
  const origin = 'http://example.test', id = 'private-dynamic-id-do-not-record';
  const reference = { response: 0, path: ['id'] };
  const base = { title: 'Read created item', path: '/', expect: [{ kind: 'title', equals: 'fixture' }] };
  const expected = { ok: 'matched', zero: 'matched', unicode: 'matched', null: 'matched', boolean: 'matched', query: 'matched',
    'wrong-path': 'path-mismatch', 'wrong-body': 'json-mismatch', 'wrong-type': 'json-mismatch',
    'bad-source': 'reference-unavailable', 'missing-field': 'reference-unavailable', 'source-duplicate': 'reference-unavailable',
    'early-target': 'reference-unavailable', 'missing-finish-time': 'reference-unavailable', 'missing-start-time': 'reference-unavailable',
    oversized: 'reference-unavailable', traversal: 'reference-unavailable', 'late-failure': 'reference-unavailable',
    'int64-exact': 'matched', 'int64-max': 'matched', 'int64-negative': 'matched',
    'int64-wrong-path': 'path-mismatch', 'int64-wrong-body': 'json-mismatch', 'int64-string': 'json-mismatch',
    'int64-exponent': 'reference-unavailable', 'int64-fraction': 'reference-unavailable',
    'integer-200': 'matched', 'integer-201': 'reference-unavailable', 'integer-nonfinite': 'reference-unavailable' };
  for (const scenario of Object.keys(expected)) {
    const sourceId = scenario.startsWith('integer-') ? BigInt('9'.repeat(scenario === 'integer-200' ? 200 : scenario === 'integer-201' ? 201 : 400))
      : scenario === 'int64-max' ? 9223372036854775807n : scenario === 'int64-negative' ? -9007199254740993n
      : scenario.startsWith('int64-') ? 9007199254740993n : ['zero', 'wrong-type'].includes(scenario) ? 0 : scenario === 'unicode' ? '商品/一' : scenario === 'null' ? null
      : scenario === 'boolean' ? false : scenario === 'oversized' ? 'x'.repeat(201) : scenario === 'traversal' ? '..' : id;
    const scalarOnly = ['null', 'boolean'].includes(scenario);
    const specs = normalizeCheck({ ...base, responses: [
      { method: 'POST', origin, path: '/items', status: 201 },
      { method: 'GET', origin, path: scalarOnly ? '/items/value' : '/items/{itemId}',
        ...(scalarOnly ? {} : { pathParams: { itemId: reference } }), ...(scenario === 'query' ? { query: { page: '2', q: 'public' } } : {}), status: 200,
        json: { path: ['id'], equalsFrom: reference } },
    ] }).responses;
    const session = new EventEmitter(), calls = [];
    let release;
    const sourceBody = new Promise(resolve => { release = resolve; });
    session.send = async (method, args) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Network.getResponseBody') {
        calls.push(args.requestId);
        if (args.requestId === 'source') await sourceBody;
        const value = args.requestId === 'source' ? sourceId : scenario === 'int64-wrong-body' ? sourceId - 1n
          : scenario === 'int64-string' ? String(sourceId) : scenario === 'wrong-body' ? 'different' : scenario === 'wrong-type' ? '0' : sourceId;
        const token = typeof value === 'bigint' ? `${value}${scenario === 'int64-exponent' ? 'e0' : scenario === 'int64-fraction' ? '.0' : ''}` : JSON.stringify(value);
        return { body: args.requestId === 'source' && scenario === 'missing-field' ? '{}' : `{"id":${token}}`, base64Encoded: false };
      }
      return {};
    };
    session.detach = async () => {};
    const observer = await observeResponses({ context: () => ({ newCDPSession: async () => session }) }, specs);
    session.emit('Network.requestWillBeSent', { requestId: 'source', frameId: 'main', timestamp: 1,
      request: { method: 'POST', url: origin + '/items' } });
    session.emit('Network.responseReceived', { requestId: 'source', response: { status: scenario === 'bad-source' ? 500 : 201, headers: { 'content-type': 'application/json' } } });
    const completion = { requestId: 'source', timestamp: scenario === 'missing-finish-time' ? undefined : 2, encodedDataLength: 100 };
    session.emit('Network.loadingFinished', completion);
    session.emit('Network.loadingFinished', completion);
    if (scenario === 'late-failure') session.emit('Network.loadingFailed', { requestId: 'source', errorText: 'net::ERR_FAILED' });
    if (scenario === 'source-duplicate') session.emit('Network.requestWillBeSent', { requestId: 'source-again', frameId: 'main', timestamp: 2.1,
      request: { method: 'POST', url: origin + '/items' } });
    session.emit('Network.requestWillBeSent', { requestId: 'target', frameId: 'main',
      timestamp: scenario === 'early-target' ? 1.5 : scenario === 'missing-start-time' ? undefined : 3,
      request: { method: 'GET', url: origin + '/items/' + (scalarOnly ? 'value' : scenario === 'int64-wrong-path' ? String(sourceId - 1n) : ['wrong-path', 'traversal'].includes(scenario) ? 'different' : encodeURIComponent(String(sourceId)))
        + (scenario === 'query' ? '?q=public&page=2' : '') } });
    session.emit('Network.responseReceived', { requestId: 'target', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    session.emit('Network.loadingFinished', { requestId: 'target', timestamp: 4, encodedDataLength: 100 });
    const finished = observer.finish(500);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const results = await finished;
    assert.equal(results[1].state, expected[scenario], scenario);
    assert.ok(calls.length <= 2 && new Set(calls).size === calls.length);
    assert.doesNotMatch(JSON.stringify(results), new RegExp(id));
    if (typeof sourceId === 'bigint') assert.ok(!JSON.stringify(results).includes(String(sourceId)));
    await observer.close();
  }
});

test('write response declarations observe once and never grant write permission', { timeout: 60_000 }, async () => {
  let method = 'PATCH';
  let status = 200;
  const hits = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/write') {
      hits.push(req.method);
      res.setHeader('content-type', 'application/json');
      if (status === 204) {
        res.writeHead(204, { 'set-cookie': ['fixture=ok; Path=/; HttpOnly', 'fixture.sig=signed; Path=/; HttpOnly'] });
        return res.end();
      }
      return res.end(JSON.stringify({ code: 0, private: PRIVATE }));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>fixture</title><button id="save">Save</button><p id="ready">Ready</p>
      <script>document.querySelector('#save').onclick=()=>fetch('/api/write',{method:'${method}'})
        .catch(()=>{}).finally(()=>document.querySelector('#ready').dataset.done='1');</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, root = workspace(origin);
  const configFile = join(root, '.heimdall/qa.json'), config = JSON.parse(readFileSync(configFile));
  try {
    for (method of ['PUT', 'PATCH', 'DELETE']) for (const allowed of [true, false]) {
      status = method === 'DELETE' ? 204 : 200;
      config.sites.web.writes = allowed ? 'allow' : 'block'; writeFileSync(configFile, JSON.stringify(config));
      const spec = { title: 'Observe write', path: '/',
        steps: [{ action: 'click', selector: '#save' }, { action: 'waitFor', selector: '#ready[data-done]' }],
        expect: [{ kind: 'title', equals: 'fixture' }],
        responses: [{ method, origin, path: '/api/write', status, ...(status === 204 ? {} : { json: { path: ['code'], equals: 0 } }) }] };
      hits.length = 0;
      const result = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/blank'], viewports: [960],
        checks: [spec], linkCheck: false, detect: false, baseline: false, failOn: 'none', github: false }, { client: 'mcp' });
      assert.equal(result.ok, allowed, JSON.stringify(result));
      assert.equal(result.result.checks[0].responses[0].state, allowed ? 'matched' : 'request-failed');
      assert.deepEqual(hits, allowed ? [method] : []);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE));
      if (!allowed) assert.equal(result.error.code, 'qa_incomplete');
    }
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('unavailable CDP evidence stays incomplete without fetching a body unnecessarily', async () => {
  const spec = { method: 'GET', origin: 'http://example.test', path: '/list', status: 200, json: { path: ['code'], equals: 0 } };
  for (const expected of ['cached', 'size-unavailable', 'body-unavailable', 'redirect', 'pending', 'empty-query']) {
    const session = new EventEmitter();
    let bodyCalls = 0;
    session.send = async method => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Network.getResponseBody') { bodyCalls++; throw new Error('not available'); }
      return {};
    };
    session.detach = async () => {};
    const page = { context: () => ({ newCDPSession: async () => session }) };
    const observer = await observeResponses(page, [spec]);
    const request = { requestId: 'one', frameId: 'main', request: { method: 'GET', url: 'http://example.test/list' + (expected === 'empty-query' ? '?&&' : '') } };
    session.emit('Network.requestWillBeSent', request);
    if (expected === 'redirect') {
      session.emit('Network.requestWillBeSent', { ...request, request: { method: 'GET', url: 'http://example.test/other' }, redirectResponse: {} });
    } else if (expected !== 'pending') {
      session.emit('Network.responseReceived', { requestId: 'one', response: { status: 200,
        headers: { 'content-type': 'application/json' }, fromDiskCache: expected === 'cached' } });
      session.emit('Network.loadingFinished', { requestId: 'one', encodedDataLength: expected === 'size-unavailable' ? 0 : 100 });
    }
    const [result] = await observer.finish(expected === 'pending' ? 0 : 200);
    assert.equal(result.state, expected === 'empty-query' ? 'missing' : expected);
    assert.equal(bodyCalls, expected === 'body-unavailable' ? 1 : 0);
    await observer.close();
  }
  for (const scenario of [
    { expected: 'matched' },
    { http: null }, { http: 200 }, { status: 200 }, { canceled: false }, { errorText: 'net::ERR_FAILED' },
    { corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } }, { blockedReason: 'inspector' },
    { cached: true }, { json: { path: ['code'], equals: 0 } },
  ]) {
    const session = new EventEmitter(); let bodyCalls = 0;
    session.send = async method => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Network.getResponseBody') bodyCalls++;
      return {};
    };
    session.detach = async () => {};
    const page = { context: () => ({ newCDPSession: async () => session }) };
    const observer = await observeResponses(page, [{ method: 'POST', origin: 'http://example.test', path: '/end',
      status: scenario.status ?? 204, ...(scenario.json ? { json: scenario.json } : {}) }]);
    session.emit('Network.requestWillBeSent', { requestId: 'end', frameId: 'main', request: { method: 'POST', url: 'http://example.test/end' } });
    if (scenario.http !== null) session.emit('Network.responseReceived', { requestId: 'end', response: { status: scenario.http ?? 204, headers: {}, fromDiskCache: scenario.cached } });
    session.emit('Network.loadingFailed', { requestId: 'end', canceled: scenario.canceled ?? true, errorText: scenario.errorText ?? 'net::ERR_ABORTED',
      corsErrorStatus: scenario.corsErrorStatus, blockedReason: scenario.blockedReason });
    const [result] = await observer.finish(0);
    assert.equal(result.state, scenario.expected ?? 'request-failed', JSON.stringify(scenario));
    assert.equal(bodyCalls, 0, 'status-only 204 observation must not fetch a body');
    await observer.close();
  }
});

test('response readiness observes the original XHR without exposing body or issuing extra requests', { timeout: 120_000 }, async () => {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = workspace(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const positive = ['ok', 'ok-get', 'string-code', 'null-field', 'status-only', 'approved-query', 'reordered-query', 'empty-value-query'];
    const run = await runQa(loadWorkspace(root), { site: 'web', pages: ['/blank'], viewports: [1280],
      checks: positive.map(name => check(origin, name)), linkCheck: false, detect: false, baseline: false }, { browser });
    for (const observed of run.run.coverage.checks) {
      assert.equal(observed.pass, true, JSON.stringify(observed));
      assert.deepEqual(observed.responses.map(({ state, http }) => ({ state, http })), [{ state: 'matched', http: 200 }]);
    }
    assert.equal(server.hits.filter(hit => hit.path === '/api/ok' && hit.method === 'POST').length, 1);
    assert.equal(server.hits.filter(hit => hit.path === '/api/ok-get' && hit.method === 'GET').length, 1);
    for (const name of ['approved-query', 'reordered-query', 'empty-value-query']) {
      assert.equal(server.hits.filter(hit => hit.path === '/api/' + name).length, 1);
      assert.ok(run.run.coverage.checks.find(item => item.id === name).responses[0].queryParams.length > 0);
    }
    for (const file of ['run.json', 'findings.json', 'report.md', 'bugs.md']) {
      assert.doesNotMatch(readFileSync(join(run.dir, file), 'utf8'), new RegExp(PRIVATE));
      assert.doesNotMatch(readFileSync(join(run.dir, file), 'utf8'), new RegExp(QUERY_MARKER));
    }
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/blank'], viewports: [1280],
      checks: [check(origin, 'approved-query')], linkCheck: false, detect: false, baseline: false, failOn: 'none', github: false });
    assert.equal(ci.ok, true, JSON.stringify(ci));
    assert.doesNotMatch(JSON.stringify(ci), new RegExp(QUERY_MARKER));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('unavailable or ambiguous response evidence cannot produce a passing check or CI', { timeout: 180_000 }, async () => {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = workspace(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const states = { 'bad-code': 'json-mismatch', 'bad-http': 'http-mismatch', 'wrong-type': 'json-mismatch',
      'missing-field': 'field-missing', nonscalar: 'field-missing', 'not-json': 'not-json', duplicate: 'ambiguous',
      missing: 'missing', blocked: 'request-failed', oversize: 'too-large', compressed: 'encoded',
      'invalid-json': 'invalid-json', query: 'missing', iframe: 'missing', 'redirect-in': 'redirect', 'empty-query': 'missing',
      'wrong-query': 'missing', 'extra-query': 'missing', 'repeated-query': 'missing', 'empty-separators-query': 'missing' };
    for (const name of Object.keys(states)) {
      const run = await runQa(loadWorkspace(root), { site: 'web', pages: ['/blank'], viewports: [1280],
        checks: [check(origin, name)], linkCheck: false, detect: false, baseline: false }, { browser });
      const observed = run.run.coverage.checks[0];
      assert.equal(observed.pass, false, `${name} must not pass`);
      assert.equal(observed.error, null, `${name}: ${observed.error}`);
      assert.equal(observed.responses[0].state, states[name], `${name} must report the actual evidence boundary`);
      if (name === 'wrong-type' || name === 'missing-field') assert.equal(observed.responses[0].failedJsonIndex, 1);
      assert.ok(run.findings.some(f => f.confidence === 'check-unverified' || f.confidence === 'check-error'), name);
      for (const file of ['run.json', 'findings.json', 'report.md', 'bugs.md']) {
        assert.doesNotMatch(readFileSync(join(run.dir, file), 'utf8'), new RegExp(PRIVATE), `${name}: ${file}`);
      }
    }
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/blank'], viewports: [1280],
      checks: [check(origin, 'bad-code')], linkCheck: false, detect: false, baseline: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(ci.error.code, 'qa_incomplete');
    assert.equal(ci.result.ci.status, 'incomplete');
    assert.equal(server.hits.filter(hit => hit.path === '/api/blocked').length, 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('a response evidence failure does not hide an independently failed page assertion', { timeout: 30_000 }, async () => {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = workspace(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const mixed = { ...check(origin, 'bad-code'), expect: [{ kind: 'title', equals: 'another title' }], loss: 'Visitors cannot find the intended page' };
    const run = await runQa(loadWorkspace(root), { site: 'web', pages: ['/blank'], viewports: [1280],
      checks: [mixed], linkCheck: false, detect: false, baseline: false }, { browser });
    const assertions = run.findings.filter(f => f.kind === 'assertion');
    assert.equal(assertions.length, 2);
    assert.ok(assertions.some(f => f.confidence === 'observed'));
    assert.ok(assertions.some(f => f.confidence === 'check-unverified'));
    assert.equal(run.run.summary.fileable, 1);
    assert.equal(new Set(assertions.map(f => f.fingerprint)).size, 2);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
