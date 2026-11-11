import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservedApiContract } from '../src/live/contract.mjs';

const body = value => ({ body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64' });

test('live/contract: groups observed API shapes and templates identifiers', () => {
  const entries = [
    { method: 'GET', url: 'https://x.test/api/items/123?page=1&token=do-not-copy', status: 200, mimeType: 'application/json', ...body({ items: [{ id: '1', name: 'Alice', email: 'alice@example.com' }], next: null }) },
    { method: 'GET', url: 'https://x.test/api/items/456?page=2', status: 200, mimeType: 'application/json', ...body({ items: [{ id: '2', name: 'Bob' }] }) },
    { method: 'GET', url: 'https://x.test/api/items/456?page=2', status: 404, mimeType: 'application/json', ...body({ error: 'missing' }) },
    { method: 'GET', url: 'https://x.test/assets/abcdef1234567890.js', status: 200, mimeType: 'text/javascript', body: null, bodyEncoding: null },
  ];
  const contract = buildObservedApiContract(entries, { siteId: 'x.test', origin: 'https://x.test', pages: 2, generatedAt: '2026-11-11T00:00:00.000Z' });
  const operation = contract.openapi.paths['/api/items/{n}'].get;

  assert.equal(contract.tier, 'B1');
  assert.equal(contract.summary.endpoints, 1);
  assert.deepEqual(operation['x-heimdall-observations'].statusCodes, [200, 404]);
  assert.deepEqual(operation['x-heimdall-observations'].queryParams, ['page']);
  assert.equal(operation.parameters.find(item => item.in === 'path').name, 'n');
  assert.equal(operation.parameters.find(item => item.in === 'query').name, 'page');
  assert.ok(operation.responses['200'].content['application/json'].schema.properties.items);
  assert.ok(!('email' in operation.responses['200'].content['application/json'].schema.properties));
  assert.equal(operation.responses['200'].content['application/json'].schema.required.includes('next'), false,
    'fields missing from one sample are not marked required');
  assert.deepEqual(contract.coverage.endpoints, { observed: 1, withErrorSample: 1, withWriteSample: 0 });
  assert.doesNotMatch(JSON.stringify(contract), /Alice|Bob|alice@example\.com|do-not-copy/);
});

test('live/contract: keeps UUID and long hash templates while separating MIME responses', () => {
  const entries = [
    { method: 'GET', url: 'https://x.test/api/items/550e8400-e29b-41d4-a716-446655440000', status: 200, mimeType: 'application/json', ...body({ ok: true }) },
    { method: 'GET', url: 'https://x.test/api/items/abcdef1234567890', status: 200, mimeType: 'text/plain', body: Buffer.from('ok').toString('base64'), bodyEncoding: 'base64' },
  ];
  const contract = buildObservedApiContract(entries, { origin: 'https://x.test' });

  assert.ok(contract.openapi.paths['/api/items/{uuid}']);
  assert.ok(contract.openapi.paths['/api/items/{id}']);
  assert.equal(contract.openapi.paths['/api/items/{id}'].get.responses['200'].content['text/plain']['x-heimdall-samples'], 1);
  assert.equal(contract.summary.withResponseSchema, 1);
});

test('live/contract: empty or static-only input is explicit B0', () => {
  const contract = buildObservedApiContract([
    { method: 'GET', url: 'https://x.test/app.js', status: 200, mimeType: 'text/javascript', body: null, bodyEncoding: null },
  ], { siteId: 'x.test', origin: 'https://x.test' });

  assert.equal(contract.tier, 'B0');
  assert.equal(contract.summary.status, 'no-observed-api');
  assert.deepEqual(contract.unknowns, [{ kind: 'no-observed-api', detail: '清洗 HAR 中没有可判定的同源接口条目。' }]);
  assert.equal(contract.coverage.invented, 0);
});
