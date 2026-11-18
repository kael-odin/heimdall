import test from 'node:test';
import assert from 'node:assert/strict';
import { hashOrganizedBrowserCandidateValue } from '../src/acceptance/browser-organized-candidate-identity.mjs';
import { hashBrowserCandidateValue } from '../src/acceptance/browser-candidate-identity.mjs';
import { sourceContent,
  candidateContent, metadataFixture } from './fixtures/acceptance-browser-organized-candidate.mjs';

test('independently derived golden identities preserve full organization and optional buildRef absence', () => {
  const golden = [{ buildRef: true,
    organization: '21dd2849417870acbc7762bf81459b3f59c3fe4260b9bc4493f673a8cdbe53c5',
    content: 'dec87bcef05bd8a4cae55ca6a8642f6b1e057596ad4da3672e695e1ab5a3537a' },
  { buildRef: false, organization: '415eae46554d31d175d08c8f0b86a220396028d8d5ec852aebdd704b767a947e',
    content: '03292a515f04e7b51f4309fe090f2169fedc10df8044e4478c4e1cd0eb9a985b' }];
  for (const expected of golden) {
    const f = metadataFixture(expected), context = { project: f.project, release: f.release, sourceBinding: f.binding };
    assert.equal(f.binding.sourceContentDigest, '17dcadf0ab987c51a95951cd0ef8b0f3424f41c960448112887d1eaceb3e32c4');
    assert.equal(hashBrowserCandidateValue('content', sourceContent(f.binding)), f.binding.sourceContentDigest);
    assert.equal(hashOrganizedBrowserCandidateValue('organization-context', context), expected.organization);
    assert.equal(hashOrganizedBrowserCandidateValue('content', candidateContent(f.candidate)), expected.content);
    assert.equal(Object.hasOwn(f.release, 'buildRef'), expected.buildRef);
  }
});

test('organized digest rejects non-JSON data without invoking accessors, hooks or proxy traps', () => {
  let calls = 0;
  const accessor = {}; Object.defineProperty(accessor, 'field', { enumerable: true, get() { calls++; return 1; } });
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error('trap'); }, ownKeys() { calls++; throw new Error('trap'); } });
  const hook = { toJSON() { calls++; return {}; } };
  const cycle = {}; cycle.self = cycle;
  const hidden = {}; Object.defineProperty(hidden, 'field', { value: 1 });
  const symbol = { [Symbol('field')]: 1 }, sparse = new Array(1), named = [1]; named.other = 2;
  for (const value of [accessor, proxy, hook, cycle, hidden, symbol, sparse, named, undefined, NaN, Infinity,
    1n, () => {}, new Date(), Object.create({ inherited: 1 })]) {
    assert.throws(() => hashOrganizedBrowserCandidateValue('content', value), TypeError);
  }
  assert.equal(calls, 0);
});
