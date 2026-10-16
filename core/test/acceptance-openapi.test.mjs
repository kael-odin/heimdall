import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { previewOpenApi, openApiDocumentFingerprint } from '../src/acceptance/openapi.mjs';
import { validateResponseSchema } from '../src/acceptance/response-schema.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAcceptanceApiFixture, ACCEPTANCE_API_CASES, ACCEPTANCE_API_HEALTHY_BODY } from './fixtures/acceptance-api.mjs';

const targetUrl = 'http://127.0.0.1:43210/preview';
const jsonResponse = schema => ({ description: 'Success', content: { 'application/json': { schema } } });
const get = schema => ({ responses: { 200: jsonResponse(schema) } });
const documentOf = paths => ({ openapi: '3.1.1', info: { title: 'Fixture API', version: '1.2.0' }, paths });
const preview = document => previewOpenApi(document, { targetUrl });
const standaloneEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

test('OpenAPI preview is an unapproved candidate with a document fingerprint and never requests document servers', async t => {
  const fixture = await startAcceptanceApiFixture();
  t.after(() => fixture.close());
  const document = documentOf({ '/healthy': { get: get({ type: 'object' }) } });
  document.servers = [{ url: fixture.targetUrl }, { url: 'https://not-authorized.invalid' }];
  const before = structuredClone(document);
  const { plan, coverage, warnings } = previewOpenApi(document, { targetUrl: fixture.targetUrl, name: 'Read-only preview' });
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(document, before);
  assert.equal(plan.mode, 'spec');
  assert.equal(plan.name, 'Read-only preview');
  assert.equal(plan.targetUrl, fixture.targetUrl + '/');
  assert.equal(plan.spec.approved, false);
  assert.equal(plan.spec.source.type, 'openapi');
  assert.equal(plan.spec.source.revision, '1.2.0');
  assert.match(plan.spec.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.spec.document, before);
  assert.equal(openApiDocumentFingerprint(plan.spec.document), plan.spec.source.sha256);
  document.info.title = 'changed after preview';
  assert.equal(plan.spec.document.info.title, before.info.title);
  assert.deepEqual(coverage, { declaredOperations: 1, candidateChecks: 1, omittedOperations: 0, complete: true, ratio: 1 });
  assert.match(warnings[0], /servers are ignored/);
});

test('OpenAPI local component schema and response refs resolve without mutating their source', () => {
  const document = documentOf({ '/healthy': { get: { responses: { 200: { $ref: '#/components/responses/Healthy' } } } } });
  document.components = { schemas: { 'Data/Model~v1': { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
    responses: { Healthy: jsonResponse({ $ref: '#/components/schemas/Data~1Model~0v1' }) } };
  const before = structuredClone(document);
  const { plan } = preview(document);
  assert.equal(plan.spec.omissions.length, 0);
  assert.equal(validateResponseSchema({ id: 7 }, plan.spec.checks[0].expect.schema).length, 0);
  assert.ok(validateResponseSchema({ id: '7' }, plan.spec.checks[0].expect.schema).length);
  assert.deepEqual(document, before);
});

test('OpenAPI 3.0 nullable expands only an explicitly declared type and preserves enum restrictions', () => {
  const document = { ...documentOf({
    '/nullable': { get: get({ type: 'string', nullable: true }) },
    '/enum': { get: get({ type: 'string', nullable: true, enum: ['ready'] }) },
    '/no-type': { get: get({ nullable: true, allOf: [{ type: 'string' }] }) },
  }), openapi: '3.0.4' };
  const schemas = Object.fromEntries(preview(document).plan.spec.checks.map(check => [check.path, check.expect.schema]));
  assert.deepEqual(schemas['/nullable'].type, ['string', 'null']);
  assert.equal(validateResponseSchema(null, schemas['/nullable']).length, 0);
  assert.ok(validateResponseSchema(null, schemas['/enum']).length);
  assert.ok(validateResponseSchema(null, schemas['/no-type']).length);
  assert.ok(!Object.hasOwn(schemas['/nullable'], 'nullable'));
});

test('OpenAPI 3.0 exclusive numeric bounds convert from its boolean syntax', () => {
  const document = { ...documentOf({ '/number': { get: get({ type: 'number', minimum: 2, exclusiveMinimum: true, maximum: 5, exclusiveMaximum: false }) } }), openapi: '3.0.4' };
  const schema = preview(document).plan.spec.checks[0].expect.schema;
  assert.equal(schema.exclusiveMinimum, 2);
  assert.equal(schema.maximum, 5);
  assert.ok(!Object.hasOwn(schema, 'minimum'));
  assert.ok(!Object.hasOwn(schema, 'exclusiveMaximum'));
  assert.ok(validateResponseSchema(2, schema).length);
  assert.equal(validateResponseSchema(5, schema).length, 0);
});

test('OpenAPI 3.1 boolean schemas and schema ref siblings retain their validation semantics', () => {
  const document = documentOf({ '/any': { get: get(true) }, '/none': { get: get(false) },
    '/bound': { get: get({ $ref: '#/components/schemas/Count', maximum: 5 }) } });
  document.components = { schemas: { Count: { type: 'integer', minimum: 1 } } };
  const schemas = Object.fromEntries(preview(document).plan.spec.checks.map(check => [check.path, check.expect.schema]));
  assert.equal(schemas['/any'], true);
  assert.equal(schemas['/none'], false);
  assert.equal(validateResponseSchema('anything', schemas['/any']).length, 0);
  assert.ok(validateResponseSchema(null, schemas['/none']).length);
  assert.equal(validateResponseSchema(4, schemas['/bound']).length, 0);
  assert.ok(validateResponseSchema(6, schemas['/bound']).length);
});

test('unsupported schemas, external refs, circular refs and ambiguous responses become one omission per operation', () => {
  const document = documentOf({
    '/pattern': { get: get({ type: 'string', pattern: '^ok$' }) },
    '/format': { get: get({ type: 'string', format: 'email' }) },
    '/remote': { get: get({ $ref: 'https://example.invalid/schema.json' }) },
    '/cycle': { get: get({ $ref: '#/components/schemas/Loop' }) },
    '/statuses': { get: { responses: { 200: jsonResponse(true), 201: jsonResponse(true) } } },
    '/range': { get: { responses: { '2XX': jsonResponse(true) } } },
    '/media': { get: { responses: { 200: { description: 'Either', content: { 'application/json': {}, 'text/plain': {} } } } } },
  });
  document.components = { schemas: { Loop: { type: 'object', properties: { next: { $ref: '#/components/schemas/Loop' } } } } };
  const { plan, coverage } = preview(document);
  assert.equal(plan.spec.checks.length, 0);
  assert.equal(plan.spec.omissions.length, 7);
  assert.equal(new Set(plan.spec.omissions.map(item => item.id)).size, 7);
  assert.equal(coverage.declaredOperations, 7);
  assert.equal(coverage.ratio, 0);
  assert.equal(coverage.complete, false);
  for (const omission of plan.spec.omissions) assert.ok(omission.reason.length > 10);
});

test('write methods, inherited authentication, request bodies, response headers and templated paths are omitted', () => {
  const document = documentOf({
    '/write': { post: get(true), delete: get(true), options: get(true) },
    '/private': { get: get(true) },
    '/public': { get: { ...get(true), security: [] } },
    '/items/{id}': { get: { ...get(true), security: [] } },
    '/body': { get: { ...get(true), security: [], requestBody: { content: {} } } },
    '/headers': { get: { security: [], responses: { 200: { ...jsonResponse(true), headers: { 'X-Quota': { schema: { type: 'integer' } } } } } } },
  });
  document.security = [{ bearer: [] }];
  const { plan, coverage } = preview(document);
  assert.deepEqual(plan.spec.checks.map(item => item.path), ['/public']);
  assert.equal(plan.spec.omissions.length, 7);
  assert.equal(coverage.declaredOperations, 8);
  assert.ok(plan.spec.omissions.some(item => /authenticated/.test(item.reason)));
  assert.ok(plan.spec.omissions.some(item => /templates/.test(item.reason)));
});

test('explicit primitive query samples use local parameter refs and operation overrides with safe serialization', () => {
  const document = documentOf({ '/search': { parameters: [{ $ref: '#/components/parameters/Query' }], get: {
    ...get({ type: 'object' }), parameters: [{ in: 'query', name: 'q', schema: { type: 'string' }, example: 'name & value' },
      { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1 }, examples: { first: { value: 2 } } }],
  } } });
  document.components = { parameters: { Query: { in: 'query', name: 'q', schema: { type: 'string' }, example: 'old' } } };
  assert.equal(preview(document).plan.spec.checks[0].path, '/search?q=name+%26+value&page=2');
});

test('missing, invalid or complex query examples are omissions rather than fabricated requests', () => {
  const document = documentOf(Object.fromEntries([
    { in: 'query', name: 'q', schema: { type: 'string' } },
    { in: 'query', name: 'n', schema: { type: 'integer' }, example: 'not a number' },
    { in: 'query', name: 'tags', schema: { type: 'array', items: { type: 'string' } }, example: ['a'] },
    { in: 'header', name: 'X-Api-Key', schema: { type: 'string' }, example: 'secret' },
    { in: 'query', name: 'q', schema: { type: 'string' }, examples: { a: { value: 'a' }, b: { value: 'b' } } },
  ].map((parameter, index) => [`/case-${index}`, { get: { ...get(true), parameters: [parameter] } }])));
  const { plan, coverage } = preview(document);
  assert.equal(plan.spec.checks.length, 0);
  assert.equal(plan.spec.omissions.length, 5);
  assert.equal(coverage.declaredOperations, 5);
});

test('HEAD checks status without reading or validating a response body; schema-free JSON GET is explicit', () => {
  const document = documentOf({ '/head': { head: { responses: { 204: { description: 'No body', content: { 'application/json': { schema: { $ref: 'https://not-requested.invalid' } } } } } } },
    '/json': { get: { responses: { 200: { description: 'JSON', content: { 'application/json': {} } } } } } });
  const { plan, warnings } = preview(document);
  assert.deepEqual(plan.spec.checks[0].expect, { status: 204 });
  assert.deepEqual(plan.spec.checks[1].expect, { status: 200, contentType: 'application/json' });
  assert.match(warnings[0], /no response schema/);
});

test('HEAD response header contracts are omissions instead of silently passing status-only checks', () => {
  const { plan, coverage } = preview(documentOf({ '/head': { head: { responses: { 200: {
    description: 'Header contract', headers: { 'X-Total': { schema: { type: 'integer' } } },
  } } } } }));
  assert.equal(plan.spec.checks.length, 0);
  assert.equal(plan.spec.omissions.length, 1);
  assert.match(plan.spec.omissions[0].reason, /header contracts/);
  assert.equal(coverage.complete, false);
  assert.equal(normalizeSpecPlan(plan).spec.omissions.length, 1);
});

test('webhooks become non-executable omissions that block downstream reports even after approval', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'heimdall-openapi-webhooks-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const document = documentOf({});
  document.webhooks = { paymentChanged: { post: { responses: { 200: { description: 'Accepted' } } } },
    readHook: { get: get(true), head: get(true) } };
  const { plan, coverage } = preview(document);
  assert.equal(plan.spec.checks.length, 0);
  assert.equal(plan.spec.omissions.length, 3);
  assert.equal(coverage.declaredOperations, 3);
  assert.equal(coverage.complete, false);
  plan.spec.approved = true;
  const report = summarizeAcceptanceReport(await runSpecAcceptance(plan, { outputDir }));
  assert.equal(report.gate, 'blocked');
  assert.equal(report.safety.requests, 0);
  assert.equal(report.checks.length, 3);
});

test('non-executable OpenAPI dialect, writeOnly response semantics and malformed nullable syntax are explicit omissions', () => {
  const dialect = documentOf({ '/ok': { get: get(true) } });
  dialect.jsonSchemaDialect = 'https://custom.invalid/dialect';
  assert.match(preview(dialect).plan.spec.omissions[0].reason, /dialects/);
  const writeOnly = preview(documentOf({ '/profile': { get: get({ type: 'object', required: ['password'], properties: { password: { type: 'string', writeOnly: true } } }) } }));
  assert.match(writeOnly.plan.spec.omissions[0].reason, /writeOnly/);
  for (const schema of [true, { type: 'string', nullable: 'yes' }, { type: 'number', minimum: 1, exclusiveMinimum: 2 }]) {
    const invalid = { ...documentOf({ '/invalid': { get: get(schema) } }), openapi: '3.0.4' };
    assert.equal(preview(invalid).plan.spec.omissions.length, 1);
  }
});

test('fingerprints are deterministic across JSON key order and change with document contents', () => {
  const original = documentOf({ '/ok': { get: get(true) } });
  const reordered = { paths: original.paths, info: { version: '1.2.0', title: 'Fixture API' }, openapi: '3.1.1' };
  assert.equal(preview(original).plan.spec.source.sha256, preview(reordered).plan.spec.source.sha256);
  reordered.info.version = '1.2.1';
  assert.notEqual(preview(original).plan.spec.source.sha256, preview(reordered).plan.spec.source.sha256);
  assert.equal(openApiDocumentFingerprint(original), preview(original).plan.spec.source.sha256);
});

test('document fingerprints preserve full JSON data and enforce exact UTF-8, nesting and node budgets', () => {
  const maxBytes = 4 * 1024 * 1024;
  const bytesOfEmpty = Buffer.byteLength(JSON.stringify({ note: '' }), 'utf8');
  const exact = { note: 'x'.repeat(maxBytes - bytesOfEmpty) };
  assert.match(openApiDocumentFingerprint(exact), /^[a-f0-9]{64}$/);
  assert.throws(() => openApiDocumentFingerprint({ note: exact.note + 'x' }), /4 MiB/);
  assert.throws(() => openApiDocumentFingerprint({ note: '中'.repeat(Math.ceil(maxBytes / 3)) }), /4 MiB/);
  let deep = {};
  for (let index = 0; index < 66; index++) deep = { child: deep };
  assert.throws(() => openApiDocumentFingerprint(deep), /complexity/);
  assert.throws(() => openApiDocumentFingerprint({ values: Array.from({ length: 100_000 }, () => 0) }), /complexity/);
  for (const invalid of [{ number: NaN }, { value: undefined }, { date: new Date() }, { values: Array(2) }]) assert.throws(() => openApiDocumentFingerprint(invalid));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => openApiDocumentFingerprint(cyclic), /circular/);
  const document = documentOf({ '/ok': { get: get(true) } });
  document['x-audit-metadata'] = { unknown: 'preserved for independent verification' };
  const plan = preview(document).plan;
  assert.deepEqual(plan.spec.document['x-audit-metadata'], document['x-audit-metadata']);
  const changed = structuredClone(plan.spec.document);
  changed['x-audit-metadata'].unknown = 'changed';
  assert.notEqual(openApiDocumentFingerprint(changed), plan.spec.source.sha256);
});

test('coverage budgets preserve every operation as a candidate or omission and reject documents that cannot fit', () => {
  const paths = Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`/item-${index}`, { get: get(true) }]));
  const { plan, coverage } = preview(documentOf(paths));
  assert.equal(plan.spec.checks.length, 32);
  assert.equal(plan.spec.omissions.length, 2);
  assert.equal(coverage.declaredOperations, 34);
  assert.match(plan.spec.omissions[0].reason, /budget of 32/);
  assert.throws(() => preview(documentOf(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`/write-${index}`, { post: get(true) }])))), /coverage budget/);
  assert.equal(preview(documentOf({})).coverage.complete, false);
});

test('invalid versions, targets, non-JSON input and unsafe paths are rejected or recorded before execution', () => {
  for (const value of [null, {}, { ...documentOf({}), openapi: '2.0' }, { ...documentOf({}), info: {} }]) assert.throws(() => preview(value));
  for (const url of ['file:///tmp/api', 'https://user:password@example.test', 'https://example.test/#fragment']) assert.throws(() => previewOpenApi(documentOf({}), { targetUrl: url }));
  const cyclic = documentOf({}); cyclic.extra = cyclic;
  assert.throws(() => preview(cyclic), /circular/);
  let getterCalled = false;
  const accessor = documentOf({}); Object.defineProperty(accessor, 'danger', { enumerable: true, get() { getterCalled = true; return 1; } });
  assert.throws(() => preview(accessor), /accessor/);
  assert.equal(getterCalled, false);
  for (const path of ['//foreign.test', '/%252e%252e/private', '/a?x=1', '/a#b', '/a\\b']) assert.equal(preview(documentOf({ [path]: { get: get(true) } })).plan.spec.omissions.length, 1);
});

test('local API fixture exposes independent content faults, bounded transport counterexamples and request evidence', async t => {
  const fixture = await startAcceptanceApiFixture({ slowMs: 150, oversizedBytes: 4096 });
  t.after(() => fixture.close());
  assert.equal(ACCEPTANCE_API_CASES.filter(item => item.targetBug).length, 7);
  assert.deepEqual(await (await fetch(fixture.targetUrl + '/healthy')).json(), ACCEPTANCE_API_HEALTHY_BODY);
  assert.equal((await (await fetch(fixture.targetUrl + '/wrong-code')).json()).code, 400);
  assert.equal((await (await fetch(fixture.targetUrl + '/missing-field')).json()).data.name, undefined);
  assert.equal(typeof (await (await fetch(fixture.targetUrl + '/wrong-type')).json()).data.id, 'string');
  assert.equal((await fetch(fixture.targetUrl + '/wrong-status')).status, 503);
  assert.match((await fetch(fixture.targetUrl + '/non-json')).headers.get('content-type'), /text\/html/);
  await assert.rejects((await fetch(fixture.targetUrl + '/bad-json')).json(), SyntaxError);
  const redirect = await fetch(fixture.targetUrl + '/redirect', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(fixture.requestCounts['/healthy'], 1);
  assert.ok((await (await fetch(fixture.targetUrl + '/oversized')).text()).length > 4096);
  await assert.rejects(fetch(fixture.targetUrl + '/slow', { signal: AbortSignal.timeout(20) }));
  const head = await fetch(fixture.targetUrl + '/head', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(fixture.requests.every(item => ['GET', 'HEAD'].includes(item.method)));
  await fixture.close();
  await fixture.close();
});

test('API fixture import is inert and lets node exit without a server or timer', () => {
  const url = new URL('./fixtures/acceptance-api.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('API fixture no-argument execution and Node test discovery exit without starting a server', () => {
  const path = fileURLToPath(new URL('./fixtures/acceptance-api.mjs', import.meta.url));
  for (const args of [[path], ['--test', path]]) {
    const result = spawnSync(process.execPath, args, { timeout: 3000, encoding: 'utf8', env: standaloneEnv() });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node core\/test\/fixtures\/acceptance-api\.mjs/);
    assert.doesNotMatch(result.stdout, /"targetUrl"/);
  }
  for (const port of ['-1', '65536', '1.5', 'not-a-port']) {
    const result = spawnSync(process.execPath, [path, port], { timeout: 3000, encoding: 'utf8', env: standaloneEnv() });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /explicit integer/);
  }
});

test('API fixture explicit port CLI prints the actual loopback URL and supports a live manual request', async t => {
  const path = fileURLToPath(new URL('./fixtures/acceptance-api.mjs', import.meta.url));
  const child = spawn(process.execPath, [path, '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: standaloneEnv() });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const startup = await Promise.race([
    once(child.stdout, 'data').then(([bytes]) => JSON.parse(bytes.toString('utf8').trim())),
    once(child, 'exit').then(([code]) => { throw new Error(`Fixture CLI exited before startup: ${code}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture CLI startup timed out')), 3000); timer.unref(); }),
  ]);
  assert.match(startup.targetUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(startup.cases, ACCEPTANCE_API_CASES.length);
  assert.deepEqual(await (await fetch(startup.targetUrl + '/healthy')).json(), ACCEPTANCE_API_HEALTHY_BODY);
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  await closed;
});
