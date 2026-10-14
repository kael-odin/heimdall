import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-interactions-'));
const previousDataDir = process.env.HEIMDALL_DATA_DIR;
process.env.HEIMDALL_DATA_DIR = dataDir;
const { saveSession } = await import('../src/session/store.mjs');
const { verifyInteractions, discoverFn } = await import('../src/verify/interactions.mjs');
const { UA } = await import('../src/ua.mjs');

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.HEIMDALL_DATA_DIR;
  else process.env.HEIMDALL_DATA_DIR = previousDataDir;
});

test('interaction discovery and replay reuse source session; clone replay sends engine token', async () => {
  const sourceUrl = 'https://private.example.test/dashboard';
  const cloneUrl = 'http://127.0.0.1:8900/static/private.example.test/index.html';
  const storageState = {
    cookies: [{ name: 'sid', value: 'test-session', domain: 'private.example.test', path: '/' }],
    origins: [],
    sessionStorage: [{ origin: 'https://private.example.test', entries: [{ name: 'auth', value: 'browser-secret' }] }],
  };
  saveSession('private.example.test', storageState);
  const previousToken = process.env.HEIMDALL_TOKEN;
  process.env.HEIMDALL_TOKEN = 'test-engine-token';

  const contexts = [];
  const initScripts = [];
  const state = { ariaExpanded: 'true', textLength: 40, visibleCount: 10 };
  const page = () => ({
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    addStyleTag: async () => {},
    evaluate: async fn => fn === discoverFn
      ? [{ selector: 'body > button:nth-of-type(1)', label: 'Open menu' }]
      : state,
    locator: () => ({ first: () => ({ click: async () => {} }) }),
    screenshot: async () => null,
  });
  const browser = {
    newContext: async options => {
      contexts.push(options);
      const index = contexts.length - 1;
      return { addInitScript: async (_fn, values) => initScripts.push({ index, values }), newPage: async () => page(), close: async () => {} };
    },
  };

  try {
    const results = await verifyInteractions(browser, { sourceUrl, cloneUrl, max: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].pass, true);
    assert.equal(contexts.length, 3, 'discovery, source click, clone click each need a context');
    for (const options of contexts.slice(0, 2)) {
      assert.deepEqual(options.storageState, { cookies: storageState.cookies, origins: storageState.origins });
      assert.equal(options.extraHTTPHeaders, undefined, 'engine token must not leak to source');
      assert.equal(options.userAgent, UA);
    }
    assert.equal(contexts[2].storageState, undefined, 'source session must not leak to clone');
    assert.deepEqual(initScripts, [0, 1].map(index => ({
      index,
      values: { 'https://private.example.test': [{ name: 'auth', value: 'browser-secret' }] },
    })), 'sessionStorage must be restored only in source contexts');
    assert.deepEqual(contexts[2].extraHTTPHeaders, { 'x-heimdall-token': 'test-engine-token' });
    assert.equal(contexts[2].userAgent, UA);
  } finally {
    if (previousToken === undefined) delete process.env.HEIMDALL_TOKEN;
    else process.env.HEIMDALL_TOKEN = previousToken;
  }
});
