import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneyArtifacts, normalizeJourneyEvent } from '../src/agent/commands/journey.mjs';

const body = value => ({ body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64' });

test('journey events keep paths and drop input values', () => {
  const event = normalizeJourneyEvent({ type: 'input', url: 'https://x.test/search?q=private', target: {
    tag: 'INPUT', role: 'textbox', type: 'text', name: 'Search', value: 'secret value',
  } }, 'https://x.test');
  assert.deepEqual(event, { type: 'input', path: '/search', target: { tag: 'input', role: 'textbox', type: 'text', name: 'Search' }, valuePresent: true });
  assert.doesNotMatch(JSON.stringify(event), /private|secret value/);
});

test('journey artifacts write only sanitized contract facts', () => {
  const result = buildJourneyArtifacts({
    siteId: 'x.test', origin: 'https://x.test', journeyId: 'journey-1', name: 'Search',
    startedAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z',
    steps: [{ type: 'navigate', url: 'https://x.test/' }, { type: 'input', url: 'https://x.test/', target: { name: 'Email' }, value: 'alice@example.com' }],
    har: { log: { entries: [{ request: { method: 'POST', url: 'https://x.test/api/search', headers: [{ name: 'Authorization', value: 'Bearer secret' }], postData: { mimeType: 'application/json', text: JSON.stringify({ query: 'private', token: 'secret' }) } }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ ok: true, email: 'alice@example.com' }) } } }] } },
  });
  assert.equal(result.contract.tier, 'B1');
  assert.deepEqual(result.contract.sources.journeys, ['journey-1']);
  assert.equal(result.journey.contract.status, 'observed');
  assert.equal(result.steps[1].valuePresent, true);
  assert.doesNotMatch(JSON.stringify({ journey: result.journey, contract: result.contract, steps: result.steps }), /alice@example\.com|private|Bearer secret/);
});
