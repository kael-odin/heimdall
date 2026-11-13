import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildObservedReplayAdapter } from '../src/live/adapter-generator.mjs';
import { splitObservedApiEntries, validateObservedReplayAdapter } from '../src/live/adapter-validation.mjs';

const jsonEntry = (url, value, overrides = {}) => ({
  method: 'GET', url, status: 200, mimeType: 'application/json',
  body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64', ...overrides,
});

test('live/adapter-validation: distinguishes large stable numbers without exposing their values', async () => {
  const entry = token => jsonEntry('https://x.test/api/items', {}, {
    body: Buffer.from(`{"id":${token},"nested":{"count":${token}},"items":[${token}]}`).toString('base64'),
  });
  const training = [entry('9007199254740993')];
  const adapter = buildObservedReplayAdapter(training, { origin: 'https://x.test' });
  const healthy = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: training });
  assert.equal(healthy.results.status, 'passed');
  for (const token of ['9007199254740992', '"9007199254740993"']) {
    const report = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: [entry(token)] });
    assert.equal(report.results.status, 'failed');
    assert.ok(report.failures[0].reasons.includes('stable-field-mismatch'));
    assert.equal(report.failures[0].reasons.includes('json-schema-mismatch'), token.startsWith('"'));
    assert.doesNotMatch(JSON.stringify(report), /900719925474099[23]|rawJSON/);
  }
});

test('live/adapter-validation: splits unique observations deterministically by endpoint', () => {
  const entries = [
    jsonEntry('https://x.test/api/items/1?view=one', { ok: true }),
    jsonEntry('https://x.test/api/items/2?view=two', { ok: true }),
    jsonEntry('https://x.test/api/items/3?view=three', { ok: true }),
    jsonEntry('https://x.test/api/health', { ok: true }),
    jsonEntry('https://x.test/api/health', { ok: true }),
  ];
  const first = splitObservedApiEntries(entries, { origin: 'https://x.test' });
  const second = splitObservedApiEntries([...entries].reverse(), { origin: 'https://x.test' });
  assert.equal(first.eligible, 4);
  assert.equal(first.duplicateEntries, 1);
  assert.equal(first.train.length, 3);
  assert.equal(first.heldout.length, 1);
  assert.deepEqual(first.train.map(item => item.url), second.train.map(item => item.url));
  assert.deepEqual(first.heldout.map(item => item.url), second.heldout.map(item => item.url));
  assert.deepEqual(first.endpoints, [
    { endpoint: 'GET /api/health', total: 1, train: 1, heldout: 0, status: 'insufficient-samples' },
    { endpoint: 'GET /api/items/{n}', total: 3, train: 2, heldout: 1, status: 'heldout' },
  ]);
});

test('live/adapter-validation: compares held-out schema and stable fields without values', async () => {
  const training = [jsonEntry('https://x.test/api/items', { ok: true, items: [{ name: 'training-only' }] })];
  const heldout = [jsonEntry('https://x.test/api/items', { ok: true, items: [{ name: 'heldout-only' }] })];
  const adapter = buildObservedReplayAdapter(training, { origin: 'https://x.test' });
  const report = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: heldout });
  assert.equal(report.tier, 'B2');
  assert.equal(report.results.status, 'passed');
  assert.equal(report.results.equivalence, 1);
  assert.deepEqual(report.failures, []);
  assert.doesNotMatch(adapter.moduleSource, /heldout-only/);
});

test('live/adapter-validation: records unobserved paths and uncovered query parameters', async () => {
  const training = [jsonEntry('https://x.test/api/items/123', { ok: true })];
  const heldoutPath = jsonEntry('https://x.test/api/items/456', { ok: true });
  const heldoutParam = jsonEntry('https://x.test/api/items/123?page=2', { ok: true });
  const adapter = buildObservedReplayAdapter(training, { origin: 'https://x.test' });
  const pathReport = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: [heldoutPath] });
  assert.equal(pathReport.results.status, 'failed');
  assert.ok(pathReport.failures[0].reasons.includes('unobserved-path'));
  assert.equal(pathReport.gapLedger.summary.unobservedPaths, 1);
  assert.deepEqual(pathReport.gapLedger.gaps[0].categories, ['unobserved-path']);

  const paramReport = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: [heldoutParam] });
  assert.equal(paramReport.results.status, 'failed');
  assert.ok(paramReport.failures[0].reasons.includes('uncovered-param:page'));
  assert.equal(paramReport.gapLedger.summary.unobservedQueryVariants, 1);
  assert.equal(paramReport.gapLedger.summary.uncoveredQueryParameters, 1);
  assert.deepEqual(paramReport.gapLedger.gaps[0].categories, ['unobserved-query-variant', 'uncovered-query-parameter']);
});

test('live/adapter-validation: records a new value or combination when query names are already known', async () => {
  const training = [jsonEntry('https://x.test/api/items?page=1', { ok: true })];
  const heldout = jsonEntry('https://x.test/api/items?page=2', { ok: true });
  const adapter = buildObservedReplayAdapter(training, { origin: 'https://x.test' });
  const report = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: [heldout] });
  assert.equal(report.results.status, 'failed');
  assert.equal(report.gapLedger.summary.unobservedQueryVariants, 1);
  assert.equal(report.gapLedger.summary.uncoveredQueryParameters, 0);
  assert.deepEqual(report.gapLedger.gaps[0].queryParams, ['page']);
  assert.deepEqual(report.gapLedger.gaps[0].categories, ['unobserved-query-variant']);
  assert.doesNotMatch(JSON.stringify(report), /page=2/);
});

test('live/adapter-validation: explicitly marks an empty held-out set as not validated', async () => {
  const training = [jsonEntry('https://x.test/api/items', { ok: true })];
  const adapter = buildObservedReplayAdapter(training, { origin: 'https://x.test' });
  const report = await validateObservedReplayAdapter(adapter, { trainingEntries: training, heldoutEntries: [] });
  assert.equal(report.results.status, 'not-validated');
  assert.equal(report.results.equivalence, null);
  assert.ok(report.unknowns.includes('heldout-set-empty'));
});
