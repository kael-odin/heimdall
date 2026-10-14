/**
 * live/har 单测：清洗（去敏感头）、索引匹配、合并统计
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHar, mergeHar, indexHar, matchHar, harStats } from '../src/live/har.mjs';

const HAR = {
  log: {
    entries: [
      { request: { method: 'GET', url: 'https://x.test/a.js' }, response: { status: 200, headers: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Set-Cookie', value: 'a=b' }], content: { mimeType: 'text/javascript', text: 'console.log(1)' } } },
      { request: { method: 'POST', url: 'https://x.test/api' }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{"ok":true}' } } },
      { request: { method: 'GET', url: 'https://x.test/fail' }, response: { status: 500, headers: [], content: {} } },
    ],
  },
};

test('live/har: sanitize strips secrets, keeps safe headers and body', () => {
  const s = sanitizeHar(HAR);
  assert.equal(s.entries.length, 1);
  assert.equal(s.privacy.excluded.nonStatic, 2);
  const a = s.entries[0];
  assert.equal(a.headers['content-type'], 'text/javascript');
  assert.ok(!('set-cookie' in a.headers), 'set-cookie must be stripped');
  assert.equal(Buffer.from(a.body, 'base64').toString('utf8'), 'console.log(1)');
});

test('live/har: index/match works by method+url with hash normalization', () => {
  const idx = indexHar(sanitizeHar(HAR, { includeApiBodies: true }).entries);
  assert.ok(matchHar(idx, 'GET', 'https://x.test/a.js#frag'));
  assert.ok(matchHar(idx, 'POST', 'https://x.test/api'));
  assert.equal(matchHar(idx, 'GET', 'https://x.test/nope'), null);
});

test('live/har: merge dedupes by key and stats count bodies', () => {
  const m = mergeHar([sanitizeHar(HAR, { includeApiBodies: true }), sanitizeHar(HAR, { includeApiBodies: true })]);
  assert.equal(m.entries.length, 3);
  const st = harStats(m.entries);
  assert.equal(st.entries, 3);
  assert.ok(st.bytes > 0);
});

test('live/har: default package omits authenticated assets, sensitive query and private response body', () => {
  const entries = [
    { request: { method: 'GET', url: 'https://x.test/app.js?token=secret' }, response: { status: 200, content: { mimeType: 'text/javascript', text: 'public' } } },
    { request: { method: 'GET', url: 'https://x.test/image.png', headers: [{ name: 'Cookie', value: 'sid=secret' }] }, response: { status: 200, content: { mimeType: 'image/png', text: 'PNG' } } },
    { request: { method: 'GET', url: 'https://x.test/config.js' }, response: { status: 200, content: { mimeType: 'text/javascript', text: 'access_token: secret' } } },
    { request: { method: 'GET', url: 'https://x.test/app.js?v=1' }, response: { status: 200, content: { mimeType: 'text/javascript', text: 'console.log(1)' } } },
    { request: { method: 'GET', url: 'https://x.test/_next/image?url=%2Favatar.png%3Ftoken%3Dsecret&w=64' }, response: { status: 200, content: { mimeType: 'image/png', text: 'PNG' } } },
    { request: { method: 'GET', url: 'https://x.test/other.js', cookies: [{ name: 'sid', value: 'secret' }] }, response: { status: 200, content: { mimeType: 'text/javascript', text: 'public' } } },
  ];
  const result = sanitizeHar({ log: { entries } });
  assert.equal(result.entries.length, 1);
  assert.equal(result.privacy.excluded.privateUrl, 2);
  assert.equal(result.privacy.excluded.authenticated, 2);
  assert.equal(result.privacy.excluded.privateBody, 1);
  assert.doesNotMatch(JSON.stringify(result), /sid=secret|token=secret|access_token: secret/);
});

test('live/har: public static paths survive, private pathname entries and their responses do not', () => {
  const staticEntry = url => ({
    request: { method: 'GET', url },
    response: { status: 200, headers: [{ name: 'ETag', value: 'public-etag' }], content: { mimeType: 'image/webp', text: 'image-bytes' } },
  });
  const publicUrls = [
    'https://x.test/assets/logo.webp',
    'https://x.test/_next/static/chunks/4f8b2a783dbd1f7c.js',
    'https://x.test/_next/image?url=%2Fpublic%2Flogo.webp&w=64',
  ];
  const privateUrls = [
    'https://x.test/avatars/alice@example.com.webp',
    'https://x.test/avatars/alice%40example.com.webp',
    'https://x.test/avatars/alice%2540example.com.webp',
    'https://x.test/users/123/avatar.webp',
    'https://x.test/reset-password/private-code-123/image.webp',
    'https://x.test/_next/image?url=%2Fusers%2F42%2Favatar.webp&w=64',
  ];
  const result = sanitizeHar({ log: { entries: [...publicUrls, ...privateUrls].map(staticEntry) } });
  assert.deepEqual(result.entries.map(e => e.url), publicUrls);
  assert.equal(result.privacy.excluded.privateUrl, privateUrls.length);
  assert.doesNotMatch(JSON.stringify(result), /alice|private-code|\/users\/42/);
  assert.ok(result.privacy.examples.every(e => e.path === 'https://x.test/[redacted]'));
  assert.equal(sanitizeHar({ log: { entries: [staticEntry(privateUrls[0])] } }, { includeApiBodies: true }).entries.length, 0);
});
