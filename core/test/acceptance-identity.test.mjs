import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAcceptanceJson, buildAcceptanceIdentity } from '../src/acceptance/identity.mjs';

const browserEnvironment = {
  platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0', browser: 'chromium', browserVersion: '145.0.0',
  playwrightVersion: '1.63.0', locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce',
};
const browser = (overrides = {}) => ({ kind: 'browser', facet: 'behavior', route: '/pricing?currency=CNY', pointId: 'open-price',
  viewport: { width: 375, height: 812 }, rule: { steps: [{ action: 'click', selector: '#price' }], assertions: [{ kind: 'visible', selector: '#panel' }] },
  oracle: { source: 'approved-snapshot', revision: 'sha256:baseline-1' }, environment: { ...browserEnvironment }, ...overrides });
const spec = (overrides = {}) => ({ kind: 'spec', facet: 'contract', route: '/items?id=1', contractId: 'list-items', method: 'GET', viewport: 'api',
  rule: { status: 200, schema: { type: 'object', required: ['code'], properties: { code: { const: 200 } } } },
  oracle: { source: 'api-contract', revision: '1' }, environment: { platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0', runner: 'node-fetch' }, ...overrides });

test('canonical JSON rejects omitted or coerced data rather than silently hashing a different value', () => {
  const values = [undefined, NaN, Infinity, -Infinity, () => {}, Symbol('x'), 1n,
    { a: undefined }, [undefined], { a: Symbol('x') }, new Date(), new Map(), new Uint8Array([1]), Object.create({ inherited: true })];
  for (const value of values) assert.throws(() => canonicalAcceptanceJson(value), TypeError);
  assert.throws(() => canonicalAcceptanceJson(new Array(1)), /dense arrays/);
  const named = [1]; named.extra = true;
  assert.throws(() => canonicalAcceptanceJson(named), /dense arrays/);
  const hidden = Object.defineProperty({}, 'secret', { value: 1 });
  assert.throws(() => canonicalAcceptanceJson(hidden), /non-enumerable/);
  assert.throws(() => canonicalAcceptanceJson({ [Symbol('key')]: 1 }), /symbol keys/);
});

test('canonical JSON rejects getters, hooks and proxies without executing them', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 'secret'; } });
  const array = Object.defineProperty([0], '0', { enumerable: true, get() { calls++; return 'secret'; } });
  const hook = { toJSON() { calls++; return 'changed'; } };
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('must not execute'); } });
  for (const value of [getter, array, hook, proxy]) assert.throws(() => canonicalAcceptanceJson(value), TypeError);
  assert.equal(calls, 0);
});

test('cycles fail while shared JSON subtrees and null-prototype objects remain valid without mutation', () => {
  const cycle = {}; cycle.self = cycle;
  const array = []; array.push(array);
  assert.throws(() => canonicalAcceptanceJson(cycle), /cycle/);
  assert.throws(() => canonicalAcceptanceJson(array), /cycle/);
  const shared = Object.freeze({ b: 2, a: 1 });
  assert.equal(canonicalAcceptanceJson(Object.freeze({ right: shared, left: shared })), '{"left":{"a":1,"b":2},"right":{"a":1,"b":2}}');
  const nullObject = Object.create(null); nullObject.__proto__ = false; nullObject.constructor = 0;
  assert.equal(canonicalAcceptanceJson(nullObject), '{"__proto__":false,"constructor":0}');
  assert.deepEqual(Object.keys(shared), ['b', 'a']);
});

test('missing or empty required environment fields return null and unsupported browser engines stay incomparable', () => {
  for (const key of Object.keys(browserEnvironment)) {
    const missing = { ...browserEnvironment }; delete missing[key];
    assert.equal(buildAcceptanceIdentity(browser({ environment: missing })), null, key);
    assert.equal(buildAcceptanceIdentity(browser({ environment: { ...browserEnvironment, [key]: ' ' } })), null, key);
  }
  for (const environment of [undefined, null, [], { ...browserEnvironment, browser: 'firefox' }]) {
    assert.equal(buildAcceptanceIdentity(browser({ environment })), null);
  }
  for (const key of ['platform', 'arch', 'nodeVersion']) {
    const environment = { ...spec().environment }; delete environment[key];
    assert.equal(buildAcceptanceIdentity(spec({ environment })), null, key);
  }
  assert.equal(buildAcceptanceIdentity(spec({ environment: { ...spec().environment, runner: 'custom' } })), null);
});

test('identity validates subject, required definitions and viewport before permitting comparison', () => {
  for (const override of [{ kind: 'other' }, { facet: '' }, { facet: 'with spaces' }, { route: '//other.test' }, { route: '/a/../b' },
    { pointId: 'bad id' }, { pointId: undefined }, { method: 'GET' }, { contractId: 'contract' }, { viewport: 'api' }, { viewport: { width: 0, height: 812 } },
    { viewport: { width: 375.1, height: 812 } }, { viewport: { width: 375, height: Number.MAX_SAFE_INTEGER + 1 } }, { rule: undefined }, { oracle: undefined }]) {
    assert.throws(() => buildAcceptanceIdentity(browser(override)));
  }
  for (const override of [{ contractId: undefined }, { method: 'POST' }, { method: 'get' }, { pointId: 'point' }, { viewport: { width: 375, height: 812 } }]) {
    assert.throws(() => buildAcceptanceIdentity(spec(override)));
  }
  let calls = 0;
  const input = browser(); Object.defineProperty(input, 'rule', { get() { calls++; return {}; } });
  assert.throws(() => buildAcceptanceIdentity(input), /accessor/);
  const environment = { ...browserEnvironment }; Object.defineProperty(environment, 'platform', { get() { calls++; return 'win32'; } });
  assert.throws(() => buildAcceptanceIdentity(browser({ environment })), /accessor/);
  assert.equal(calls, 0);
});
