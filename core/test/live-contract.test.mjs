import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildObservedApiContract } from '../src/live/contract.mjs';
import { MAX_PUBLIC_BINARY_BYTES, sanitizeHar } from '../src/live/har.mjs';
import { readDataPlan } from '../src/live/read-data-plan.mjs';

const body = value => ({ body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), bodyEncoding: 'base64' });

test('live/contract: mixed observations retain every type and merge nullable object fields', () => {
  const values = [
    { amount: 1, detail: null },
    { amount: 2.5, detail: { count: 1 } },
    { amount: null, detail: { count: 2.5, unit: 'piece' } },
    { amount: 'free', detail: null },
    { amount: 3, detail: { count: 4 } },
  ];
  const infer = items => buildObservedApiContract([
    { method: 'GET', url: 'https://x.test/api/mixed', status: 200, mimeType: 'application/json', ...body(items) },
    { method: 'GET', url: 'https://x.test/api/null', status: 200, mimeType: 'application/json', ...body(null) },
  ], { origin: 'https://x.test' });
  const contract = infer(values);
  const items = contract.openapi.paths['/api/mixed'].get.responses[200].content['application/json'].schema.items;
  assert.deepEqual(items.properties.amount.oneOf.map(item => item.type), ['null', 'number', 'string']);
  assert.deepEqual(items.properties.detail.oneOf.map(item => item.type), ['null', 'object']);
  const detail = items.properties.detail.oneOf.find(item => item.type === 'object');
  assert.equal(detail.properties.count.type, 'number');
  assert.deepEqual(detail.required, ['count']);
  assert.equal(detail.properties.unit.type, 'string');
  assert.deepEqual(infer([...values].reverse()).openapi.paths['/api/mixed'].get.responses[200].content['application/json'].schema.items, items);
  assert.equal(contract.openapi.paths['/api/null'].get.responses[200].content['application/json'].schema.type, 'null');
  const literal = infer([JSON.parse('{"__proto__":null}')]).openapi.paths['/api/mixed'].get.responses[200].content['application/json'].schema.items;
  assert.equal(Object.hasOwn(literal.properties, '__proto__'), true);
  assert.equal(literal.properties.__proto__.type, 'null');
});

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
  assert.deepEqual(contract.coverage.endpoints, {
    observed: 1, withErrorSample: 1, withWriteSample: 0, withRequestSchema: 0, authObserved: 0,
  });
  assert.doesNotMatch(JSON.stringify(contract), /Alice|Bob|alice@example\.com|do-not-copy/);
});

test('live/contract: exposes observed request schema and auth shape without values', () => {
  const sanitized = sanitizeHar({ log: { entries: [{
    request: {
      method: 'POST', url: 'https://x.test/api/items',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer fixture-secret' },
      ],
      postData: { mimeType: 'application/json', text: JSON.stringify({ title: 'Draft', secret: 'do-not-copy', count: 1 }) },
    },
    response: { status: 201, content: { mimeType: 'application/json', text: '{"id":1}' } },
  }] } }, { includeApiBodies: true });
  const contract = buildObservedApiContract(sanitized.entries, { origin: 'https://x.test' });
  const operation = contract.openapi.paths['/api/items'].post;

  assert.deepEqual(operation['x-heimdall-auth'], { schemes: ['bearer'], observations: 1 });
  assert.equal(operation.requestBody.content['application/json'].schema.properties.title.type, 'string');
  assert.equal(operation.requestBody.content['application/json'].schema.properties.count.type, 'integer');
  assert.ok(!('secret' in operation.requestBody.content['application/json'].schema.properties));
  assert.deepEqual(contract.summary.authSchemes, ['bearer']);
  assert.equal(contract.summary.withRequestSchema, 1);
  assert.deepEqual(contract.coverage.endpoints, {
    observed: 1, withErrorSample: 0, withWriteSample: 1, withRequestSchema: 1, authObserved: 1,
  });
  assert.ok(contract.unknowns.some(item => item.kind === 'auth-unknown' && item.observedSchemes?.includes('bearer')));
  assert.doesNotMatch(JSON.stringify(contract), /fixture-secret|do-not-copy|Draft/);
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

test('live/har: approved binary downloads require base64, stay bounded, and need manual review', () => {
  const origin = 'https://x.test';
  const binary = value => ({
    request: { method: 'GET', url: origin + value.path, headers: value.headers ?? [] },
    response: {
      status: 200,
      headers: value.responseHeaders ?? [],
      content: { mimeType: value.mimeType ?? 'application/octet-stream', text: value.body,
        ...(value.encoding === undefined ? {} : { encoding: value.encoding }) },
    },
  });
  const goodBody = Buffer.from([0, 1, 2, 255]).toString('base64');
  const oversizedBody = Buffer.alloc(MAX_PUBLIC_BINARY_BYTES + 1).toString('base64');
  const result = sanitizeHar({ log: { entries: [
    binary({ path: '/library.db', body: goodBody, encoding: 'base64' }),
    binary({ path: '/manual.docx', body: goodBody, encoding: 'base64',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    binary({ path: '/wrong-encoding.db', body: goodBody, encoding: 'utf8' }),
    binary({ path: '/cookie.db', body: goodBody, encoding: 'base64', headers: [{ name: 'Cookie', value: 'sid=secret' }] }),
    binary({ path: '/large.db', body: oversizedBody, encoding: 'base64' }),
  ] } }, {
    readOnlyOrigin: origin,
    readOnlyBinaryGetUrls: ['/library.db', '/manual.docx', '/wrong-encoding.db', '/cookie.db', '/large.db']
      .map(path => origin + path),
  });

  assert.deepEqual(result.entries.map(entry => [entry.url, entry.kind, entry.review]), [
    [origin + '/library.db', 'public-read-only-binary', 'manual'],
    [origin + '/manual.docx', 'public-read-only-binary', 'manual'],
  ]);
  assert.equal(result.privacy.excluded.privateBody, 2);
  assert.equal(result.privacy.excluded.authenticated, 1);
  assert.equal(Buffer.from(result.entries[0].body, 'base64').toString('hex'), '000102ff');
});

test('live/read-data-plan: binary-only plans are explicit and cannot overlap data paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-read-data-plan-'));
  try {
    writeFileSync(join(root, 'read-data-plan.json'), JSON.stringify({ version: 1, binaryPaths: ['/library.db'] }));
    assert.equal(readDataPlan(root, 'https://x.test').issue, 'binary-requires-flag');
    assert.deepEqual(readDataPlan(root, 'https://x.test', { includeBinary: true }), {
      status: 'ok', urls: [], binaryUrls: ['https://x.test/library.db'],
    });
    writeFileSync(join(root, 'read-data-plan.json'), JSON.stringify({
      version: 1, paths: ['/library.db'], binaryPaths: ['/library.db'],
    }));
    assert.equal(readDataPlan(root, 'https://x.test', { includeBinary: true }).issue, 'overlapping-paths');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
