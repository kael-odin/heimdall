import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PX_PROXY_LIMITS, PxProxyError, fetchPxUpstream, pxResponseHeaders, readPxResponseBody,
} from '../src/px-proxy.mjs';

test('px proxy follows bounded same-origin redirects and records the hop count', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    if (url === 'https://fixture.test/start') return new Response(null, { status: 302, headers: { location: '/middle' } });
    if (url === 'https://fixture.test/middle') return new Response(null, { status: 307, headers: { location: '/final' } });
    return new Response('ok', { status: 200 });
  };
  const result = await fetchPxUpstream('https://fixture.test/start', { origin: 'https://fixture.test', fetchImpl });
  assert.equal(result.finalUrl, 'https://fixture.test/final');
  assert.equal(result.redirects, 2);
  assert.deepEqual(calls.map(call => call.redirect), ['manual', 'manual', 'manual']);
});

test('px proxy refuses a cross-origin redirect before requesting the second origin', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  };
  await assert.rejects(
    fetchPxUpstream('https://fixture.test/start', { origin: 'https://fixture.test', fetchImpl }),
    error => error instanceof PxProxyError && error.code === 'PX_PROXY_REDIRECT_BLOCKED' && error.status === 502,
  );
  assert.deepEqual(calls, ['https://fixture.test/start']);
});

test('px proxy caps redirects and rejects malformed or credentialed locations', async () => {
  const repeated = async () => new Response(null, { status: 302, headers: { location: '/again' } });
  await assert.rejects(
    fetchPxUpstream('https://fixture.test/start', { origin: 'https://fixture.test', fetchImpl: repeated, maxRedirects: 2 }),
    error => error.code === 'PX_PROXY_TOO_MANY_REDIRECTS',
  );
  for (const location of ['https://user:secret@fixture.test/next', 'javascript:alert(1)', 'http://fixture.test/next']) {
    await assert.rejects(
      fetchPxUpstream('https://fixture.test/start', {
        origin: 'https://fixture.test',
        fetchImpl: async () => new Response(null, { status: 302, headers: { location } }),
      }),
      error => error.code === 'PX_PROXY_REDIRECT_BLOCKED',
      location,
    );
  }
});

test('px response headers remove cookies and hop-by-hop fields', () => {
  const source = new Headers([
    ['content-type', 'application/json'],
    ['set-cookie', 'sid=secret; HttpOnly'],
    ['set-cookie2', 'legacy=secret'],
    ['connection', 'keep-alive'],
    ['transfer-encoding', 'chunked'],
    ['x-test', 'kept'],
  ]);
  const headers = pxResponseHeaders(source);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-test'), 'kept');
  for (const name of ['set-cookie', 'set-cookie2', 'connection', 'transfer-encoding']) assert.equal(headers.has(name), false, name);
});

test('px response body rejects declared and streamed oversize responses', async () => {
  await assert.rejects(
    readPxResponseBody(new Response('small', { headers: { 'content-length': String(PX_PROXY_LIMITS.maxResponseBytes + 1) } })),
    error => error.code === 'PX_PROXY_RESPONSE_TOO_LARGE',
  );
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readPxResponseBody(new Response(stream), { maxBytes: 8 }), error => error.code === 'PX_PROXY_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
});
