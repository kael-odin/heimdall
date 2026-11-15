import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: key => ({ 'heimdall-token': 'test-token', 'heimdall-api': 'https://engine.example' })[key] ?? null,
};
globalThis.location = { port: '443', protocol: 'https:', origin: 'https://engine.example', hostname: 'engine.example' };

const { liveUrl, engineSupportsMirror, mirrorBridgeNeeded, openMirrorWithTicket } = await import('../../console/src/pages.js');

test('remote engine uses the configured engine origin for mirror launch', () => {
  const page = { url: 'https://fixture.test/docs' };
  assert.equal(engineSupportsMirror(), true);
  assert.equal(mirrorBridgeNeeded(), false);
  assert.match(liveUrl(page), /^https:\/\/engine\.example\/api\/mirror-launch/);
});

test('remote engine on another hostname still identifies a cross-origin bridge', () => {
  globalThis.location = { port: '', protocol: 'https:', origin: 'https://console.example', hostname: 'console.example' };
  globalThis.localStorage = { getItem: key => key === 'heimdall-token' ? 'test-token' : key === 'heimdall-api' ? 'https://engine.example' : null };
  assert.equal(engineSupportsMirror(), true);
  assert.equal(mirrorBridgeNeeded(), true);
  assert.match(liveUrl({ url: 'https://fixture.test/' }), /^https:\/\/engine\.example\/api\/mirror-launch/);
  globalThis.localStorage = { getItem: key => key === 'heimdall-api' ? 'https://engine.example' : null };
});

test('remote engine accepts a public mirror ticket host', async () => {
  globalThis.localStorage = { getItem: key => key === 'heimdall-token' ? 'test-token' : key === 'heimdall-api' ? 'https://engine.example' : null };
  const replaced = [];
  globalThis.window = {
    open() {
      return { closed: false, opener: null, location: { replace(url) { replaced.push(url); } }, close() {} };
    },
    location: { assign() {} },
  };
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      url: 'https://fixture.test.mirror.example/.heimdall/session?ticket=ticket-1',
      siteId: 'fixture.test', origin: 'https://fixture.test',
    }) });
    await openMirrorWithTicket({ url: 'https://fixture.test/docs' });
    assert.equal(replaced[0], 'https://fixture.test.mirror.example/.heimdall/session?ticket=ticket-1');
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.window;
  }
});

test('remote engine cannot construct a mirror launch URL', () => {
  globalThis.localStorage = { getItem: key => key === 'heimdall-api' ? 'https://engine.example' : null };
  assert.equal(liveUrl({ url: 'https://fixture.test/docs' }), '#');
});
