import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_ORGANIZED_CANDIDATE_V1, hashOrganizedBrowserCandidateValue } from '../src/acceptance/browser-organized-candidate-identity.mjs';
import { hashBrowserCandidateValue } from '../src/acceptance/browser-candidate-identity.mjs';
import { browserCandidateContentOf } from '../src/acceptance/catalog-schema.mjs';
import { AT, LATER, uid, copy, independentHash, organizedHash, sourceContent,
  candidateContent, metadataFixture } from './fixtures/acceptance-browser-organized-candidate.mjs';

test('organized Browser identity has its own frozen versioned domain', () => {
  assert.deepEqual(BROWSER_ORGANIZED_CANDIDATE_V1, { candidateContractVersion: 1,
    canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
    domain: 'heimdall-acceptance-browser-organized-candidate' });
  assert.equal(Object.isFrozen(BROWSER_ORGANIZED_CANDIDATE_V1), true);
  const value = { fixture: 'format-only' };
  const actual = hashOrganizedBrowserCandidateValue('content', value);
  assert.equal(actual, organizedHash('content', value));
  assert.notEqual(actual, hashOrganizedBrowserCandidateValue('organization-context', value));
  assert.notEqual(actual, hashBrowserCandidateValue('content', value));
  assert.notEqual(actual, independentHash(value));
  for (const [key, replacement] of [['domain', 'other-domain'], ['candidateContractVersion', 2],
    ['canonicalJsonVersion', 'other-json'], ['digestAlgorithm', 'other-algorithm']]) {
    assert.notEqual(actual, independentHash({ ...BROWSER_ORGANIZED_CANDIDATE_V1, [key]: replacement, kind: 'content', value }));
  }
});

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

test('same source projection in a different valid organization keeps source identity and changes both new layers', () => {
  const first = metadataFixture(), other = metadataFixture({ organizationOffset: 100 });
  assert.deepEqual(sourceContent(first.binding), sourceContent(other.binding));
  assert.equal(first.binding.sourceContentDigest, other.binding.sourceContentDigest);
  assert.notEqual(first.candidate.organizationContextDigest, other.candidate.organizationContextDigest);
  assert.notEqual(first.candidate.contentDigest, other.candidate.contentDigest);
  for (const [section, field, value] of [['project', 'id', uid('ap', 100)], ['release', 'id', uid('ar', 100)],
    ['sourceBinding', 'id', uid('ax', 100)], ['project', 'name', '改名'], ['project', 'createdAt', LATER],
    ['release', 'label', '改版本名'], ['release', 'buildRef', 'other-build'], ['release', 'createdAt', LATER],
    ['sourceBinding', 'boundAt', LATER]]) {
    const context = { project: copy(first.project), release: copy(first.release), sourceBinding: copy(first.binding) };
    context[section][field] = value;
    assert.notEqual(hashOrganizedBrowserCandidateValue('organization-context', context), first.candidate.organizationContextDigest, section + '.' + field);
  }
});

test('Browser candidate content explicitly excludes storage identity, creation time, actor and catalog CAS', () => {
  const f = metadataFixture(), original = copy(f.candidate), changed = { ...copy(original), id: uid('bc', 100), createdAt: LATER };
  assert.deepEqual(browserCandidateContentOf(original), candidateContent(original));
  assert.deepEqual(browserCandidateContentOf(changed), candidateContent(original));
  assert.deepEqual(Object.keys(browserCandidateContentOf(original)).sort(), ['candidateContractVersion', 'mode', 'projectId',
    'releaseId', 'sourceBindingId', 'sourceContentDigest', 'organizationContextDigest'].sort());
  assert.notEqual(independentHash(original), independentHash(changed));
  f.catalog.generationId = uid('ag', 101); f.catalog.revision = 1234;
  assert.equal(hashOrganizedBrowserCandidateValue('content', browserCandidateContentOf(f.candidate)), original.contentDigest);
  assert.equal(original.createdAt, AT);
});

test('canonical keys are stable while arrays and complete ordered query values remain significant', () => {
  const value = { z: [1, { b: true, a: '中文' }], a: null }, reordered = { a: null, z: [1, { a: '中文', b: true }] };
  assert.equal(hashOrganizedBrowserCandidateValue('content', value), hashOrganizedBrowserCandidateValue('content', reordered));
  const nullObject = Object.assign(Object.create(null), reordered);
  assert.equal(hashOrganizedBrowserCandidateValue('content', value), hashOrganizedBrowserCandidateValue('content', nullObject));
  assert.notEqual(hashOrganizedBrowserCandidateValue('content', [1, 2]), hashOrganizedBrowserCandidateValue('content', [2, 1]));
  const f = metadataFixture(), context = { project: f.project, release: f.release, sourceBinding: f.binding };
  for (const query of ['?tenant=two&tenant=one&token=fixture-value', '?tenant=one&tenant=two&token=other', '', '?']) {
    const changed = copy(context); changed.release.targetUrl = 'https://example.test/app' + query;
    changed.sourceBinding.source.entryUrl = changed.release.targetUrl;
    assert.notEqual(hashOrganizedBrowserCandidateValue('organization-context', changed), f.candidate.organizationContextDigest);
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
