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
const GET_CASES = new Set(['ok-get', 'redirect-in', 'approved-query', 'reordered-query', 'empty-value-query', 'wrong-query', 'extra-query', 'repeated-query']);

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
          : name === 'query' ? '?different=1' : name === 'empty-query' ? '?' : '';
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
        : JSON.stringify({ ...(name === 'missing-field' ? {} : { code }), private: PRIVATE,
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
      ...(name === 'status-only' ? {} : { json: { path: ['code'], equals: name === 'string-code' ? '0' : name === 'null-field' ? null : 0 } }) }] };
}

test('response checks reject ambiguous or unsafe declarations', () => {
  const base = { title: 'response', path: '/', expect: [{ kind: 'title', equals: 'fixture' }] };
  const response = { method: 'POST', origin: 'http://127.0.0.1:1234', path: '/api/list', status: 200, json: { path: ['code'], equals: 0 } };
  assert.deepEqual(normalizeCheck({ ...base, responses: [response] }).responses, [response]);
  for (const invalid of [
    { ...response, origin: 'http://user:pass@127.0.0.1:1234' },
    { ...response, origin: 'http://127.0.0.1:1234/path' },
    { ...response, path: '/api/list?token=secret' },
    { ...response, path: '/api/%2e%2e/list' },
    { ...response, method: 'DELETE' },
    { ...response, status: null },
    { ...response, json: { path: [], equals: 0 } },
    { ...response, json: { path: ['code'], equals: { nested: true } } },
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

test('unavailable CDP evidence stays incomplete without fetching a body unnecessarily', async () => {
  const spec = { method: 'GET', origin: 'http://example.test', path: '/list', status: 200, json: { path: ['code'], equals: 0 } };
  for (const expected of ['cached', 'size-unavailable', 'body-unavailable', 'redirect', 'pending']) {
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
    const request = { requestId: 'one', frameId: 'main', request: { method: 'GET', url: 'http://example.test/list' } };
    session.emit('Network.requestWillBeSent', request);
    if (expected === 'redirect') {
      session.emit('Network.requestWillBeSent', { ...request, request: { method: 'GET', url: 'http://example.test/other' }, redirectResponse: {} });
    } else if (expected !== 'pending') {
      session.emit('Network.responseReceived', { requestId: 'one', response: { status: 200,
        headers: { 'content-type': 'application/json' }, fromDiskCache: expected === 'cached' } });
      session.emit('Network.loadingFinished', { requestId: 'one', encodedDataLength: expected === 'size-unavailable' ? 0 : 100 });
    }
    const [result] = await observer.finish(expected === 'pending' ? 0 : 200);
    assert.equal(result.state, expected);
    assert.equal(bodyCalls, expected === 'body-unavailable' ? 1 : 0);
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
      'wrong-query': 'missing', 'extra-query': 'missing', 'repeated-query': 'missing' };
    for (const name of Object.keys(states)) {
      const run = await runQa(loadWorkspace(root), { site: 'web', pages: ['/blank'], viewports: [1280],
        checks: [check(origin, name)], linkCheck: false, detect: false, baseline: false }, { browser });
      const observed = run.run.coverage.checks[0];
      assert.equal(observed.pass, false, `${name} must not pass`);
      assert.equal(observed.error, null, `${name}: ${observed.error}`);
      assert.equal(observed.responses[0].state, states[name], `${name} must report the actual evidence boundary`);
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
