import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReplayableReadOnlyDataEntry, isSafeReadOnlyGetUrl, sanitizeHar } from '../src/live/har.mjs';

const SOURCE = fileURLToPath(new URL('../src/live/', import.meta.url));
const ORIGIN = 'https://origin.test';

function entry(url, body, { method = 'GET', mimeType = 'application/json', requestHeaders = [], responseHeaders = [], status = 200 } = {}) {
  return {
    request: { method, url, headers: requestHeaders },
    response: { status, headers: responseHeaders, content: { mimeType, text: body } },
  };
}

function clean(entries, urls) {
  return sanitizeHar({ log: { entries } }, { readOnlyOrigin: ORIGIN, readOnlyGetUrls: urls });
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('bundle server exited before ready');
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('bundle server did not start');
}

test('read-only data is absent by default and requires an exact same-origin URL', () => {
  const url = ORIGIN + '/api/catalog?page=2';
  const raw = entry(url, '{"items":[{"title":"Example"}]}');
  assert.equal(sanitizeHar({ log: { entries: [raw] } }).entries.length, 0);
  const result = clean([raw], [url]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, 'public-read-only-data');
  assert.equal(result.entries[0].mimeType, 'application/json; charset=utf-8');
  assert.deepEqual(result.entries[0].headers, {});
  assert.equal(Buffer.from(result.entries[0].body, 'base64').toString(), '{"items":[{"title":"Example"}]}');
  assert.equal(clean([raw], [ORIGIN + '/api/catalog?page=3']).entries.length, 0);
  assert.equal(isSafeReadOnlyGetUrl(url, ORIGIN), true);
  assert.equal(isSafeReadOnlyGetUrl(ORIGIN + '/api/catalog?search=public', ORIGIN), true);
  assert.equal(isSafeReadOnlyGetUrl(ORIGIN + '/api/catalog?user_id=42', ORIGIN), false);
  assert.throws(() => clean([raw], ['https://other.test/api/catalog?page=2']), /unsafe readOnlyGetUrl/);
  assert.throws(() => clean([raw], [ORIGIN + '/api/catalog?access_token=value']), /unsafe readOnlyGetUrl/);
  assert.throws(() => clean([raw], [ORIGIN + '/api/catalog?q=alice%2540example.com']), /unsafe readOnlyGetUrl/);
});

test('read-only data excludes authentication, writes, response cookies, private bodies and failed responses', () => {
  const cases = [
    [entry(ORIGIN + '/api/cookie', '{}', { requestHeaders: [{ name: 'Cookie', value: 'sid=private' }] }), 'authenticated'],
    [entry(ORIGIN + '/api/auth', '{}', { requestHeaders: [{ name: 'X-Session-Token', value: 'secret' }] }), 'authenticated'],
    [entry(ORIGIN + '/api/x-token', '{}', { requestHeaders: [{ name: 'X-Token', value: 'secret' }] }), 'authenticated'],
    [entry(ORIGIN + '/api/set-cookie', '{}', { responseHeaders: [{ name: 'Set-Cookie', value: 'sid=private' }] }), 'authenticated'],
    [entry(ORIGIN + '/api/cache-private', '{}', { responseHeaders: [{ name: 'Cache-Control', value: 'private, no-store' }] }), 'authenticated'],
    [entry(ORIGIN + '/api/post', '{}', { method: 'POST' }), 'nonStatic'],
    [entry(ORIGIN + '/api/error', '{"message":"failed"}', { status: 500 }), 'nonStatic'],
    [entry(ORIGIN + '/api/email', '{"contact":"alice@example.com"}'), 'privateBody'],
    [entry(ORIGIN + '/api/escaped-email', '{"contact":"alice\\u0040example.com"}'), 'privateBody'],
    [entry(ORIGIN + '/api/profile', '{"account":{"id":1}}'), 'privateBody'],
    [entry(ORIGIN + '/api/key', '{"x_api_key":"secret"}'), 'privateBody'],
    [entry(ORIGIN + '/api/invalid', '{bad json'), 'privateBody'],
  ];
  for (const [raw, reason] of cases) {
    const sanitized = clean([raw], [raw.request.url]);
    assert.equal(sanitized.entries.length, 0, raw.request.url);
    assert.equal(sanitized.privacy.excluded[reason], 1, raw.request.url);
    assert.doesNotMatch(JSON.stringify(sanitized), /sid=private|alice@example.com|X-Session-Token/);
  }
  const text = clean([entry(ORIGIN + '/data.txt', 'public data', { mimeType: 'text/plain' })], [ORIGIN + '/data.txt']);
  assert.equal(text.entries[0].mimeType, 'text/plain; charset=utf-8');
  assert.ok(isReplayableReadOnlyDataEntry(text.entries[0], ORIGIN));
  assert.equal(isReplayableReadOnlyDataEntry({ ...text.entries[0], body: Buffer.from('Bearer abcdefghi').toString('base64') }, ORIGIN), false);
});

test('email redaction retains the original local-part and domain boundaries', () => {
  const url = ORIGIN + '/api/text';
  for (const body of ['a@x.io', 'name+tag@sub.example.com', 'x-y@x.io']) {
    assert.equal(clean([entry(url, body, { mimeType: 'text/plain' })], [url]).privacy.excluded.privateBody, 1, body);
  }
  for (const body of ['@x.io', 'a@.io', 'a@x.y']) {
    assert.equal(clean([entry(url, body, { mimeType: 'text/plain' })], [url]).entries.length, 1, body);
  }
});

test('HAR sanitizer handles a long public token in bounded time', () => {
  const script = `import { sanitizeHar } from './src/live/har.mjs';
    const origin = 'https://origin.test';
    const url = origin + '/api/text';
    const har = { log: { entries: [{ request: { method: 'GET', url, headers: [] },
      response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'x'.repeat(800_000) } } }] } };
    const result = sanitizeHar(har, { readOnlyOrigin: origin, readOnlyGetUrls: [url] });
    if (result.entries.length !== 1) process.exitCode = 1;`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 5_000, encoding: 'utf8',
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
});

test('standalone offline bundle replays approved GET data exactly, without an upstream', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-read-only-data-'));
  const port = await freePort();
  const approvedUrl = ORIGIN + '/api/catalog?page=2';
  const sanitized = clean([entry(approvedUrl, '{"items":["public"]}')], [approvedUrl]);
  const poison = {
    ...sanitized.entries[0], url: ORIGIN + '/api/poison',
    body: Buffer.from('{"email":"alice@example.com"}').toString('base64'),
  };
  writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [...sanitized.entries, poison] }));
  writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({
    host: 'origin.test', origin: ORIGIN, port, bind: '127.0.0.1', offline: true, root: 'mirror',
  }));
  for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs', 'clone-asset-cors.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));
  const child = spawn(process.execPath, [join(dir, 'serve.mjs')], { cwd: dir, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    await ready(base + '/__heimdall/health', child);
    const hit = await fetch(base + '/api/catalog?page=2');
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('x-heimdall-replay'), '1');
    assert.equal(hit.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await hit.json(), { items: ['public'] });
    assert.equal((await fetch(base + '/api/catalog?page=3')).status, 404);
    assert.equal((await fetch(base + '/api/poison')).status, 404);
    assert.equal((await fetch(base + '/api/catalog?page=2', { method: 'POST' })).status, 404);
    assert.equal((await fetch(base + '/lm/origin.test/api/catalog?page=2')).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
