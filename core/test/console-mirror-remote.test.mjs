import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: key => ({ 'heimdall-token': 'test-token', 'heimdall-api': 'https://engine.example' })[key] ?? null,
};
globalThis.location = { port: '443', protocol: 'https:', origin: 'https://engine.example', hostname: 'engine.example' };

const { liveUrl, localEngineSupportsMirror, mirrorBridgeNeeded } = await import('../../console/src/pages.js');

test('remote engine disables localhost mirror even when console and API hostname match', () => {
  const page = { url: 'https://fixture.test/docs' };
  assert.equal(localEngineSupportsMirror(), false);
  assert.equal(mirrorBridgeNeeded(), false);
  assert.equal(liveUrl(page), '#');
});

test('remote engine on another hostname still identifies a cross-origin bridge', () => {
  globalThis.location = { port: '', protocol: 'https:', origin: 'https://console.example', hostname: 'console.example' };
  assert.equal(mirrorBridgeNeeded(), true);
  assert.equal(liveUrl({ url: 'https://fixture.test/' }), '#');
});

test('remote engine cannot construct a mirror launch URL', () => {
  assert.equal(liveUrl({ url: 'https://fixture.test/docs' }), '#');
});
