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
  assert.equal(s.entries.length, 3);
  const a = s.entries[0];
  assert.equal(a.headers['content-type'], 'text/javascript');
  assert.ok(!('set-cookie' in a.headers), 'set-cookie must be stripped');
  assert.equal(Buffer.from(a.body, 'base64').toString('utf8'), 'console.log(1)');
});

test('live/har: index/match works by method+url with hash normalization', () => {
  const idx = indexHar(sanitizeHar(HAR).entries);
  assert.ok(matchHar(idx, 'GET', 'https://x.test/a.js#frag'));
  assert.ok(matchHar(idx, 'POST', 'https://x.test/api'));
  assert.equal(matchHar(idx, 'GET', 'https://x.test/nope'), null);
});

test('live/har: merge dedupes by key and stats count bodies', () => {
  const m = mergeHar([sanitizeHar(HAR), sanitizeHar(HAR)]);
  assert.equal(m.entries.length, 3);
  const st = harStats(m.entries);
  assert.equal(st.entries, 3);
  assert.ok(st.bytes > 0);
});
