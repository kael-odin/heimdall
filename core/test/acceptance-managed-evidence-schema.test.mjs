import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { normalizeSpecPlan, SPEC_LIMITS } from '../src/acceptance/spec-schema.mjs';
import { previewOpenApi } from '../src/acceptance/openapi.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { ManagedAcceptanceRunError } from '../src/acceptance/managed-run-schema.mjs';
import { validateManagedSpecEvidence } from '../src/acceptance/managed-evidence-schema.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const cloneFiles = files => new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
const changeFile = (files, name, mutate) => { const value = JSON.parse(files.get(name)); mutate(value); files.set(name, Buffer.from(JSON.stringify(value))); };
const rejected = action => assert.throws(action, error => {
  assert.ok(error instanceof ManagedAcceptanceRunError); assert.ok([400, 409].includes(error.status));
  assert.ok(['INVALID_INPUT', 'MANAGED_RUN_INTEGRITY_FAILED'].includes(error.code)); assert.deepEqual(error.details, { reason: 'INVALID_INPUT' });
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /SECRET|[A-Z]:\\|\/tmp\//);
  return true;
});
const contract = (id, method = 'GET') => ({ id, title: id, method, path: '/' + id, severity: 'high',
  expect: { status: 200, contentType: 'application/json', ...(method === 'HEAD' ? {} : { json: [{ pointer: '/code', kind: 'equals', value: 0 }] }) } });

async function fixture(t, openapi = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-evidence-')), requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url); const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (path.endsWith('/slow')) return;
    if (path.endsWith('/status')) { response.statusCode = 503; response.setHeader('content-type', 'text/plain'); return response.end('Unavailable'); }
    if (path.endsWith('/invalid')) return response.end('{');
    if (path.endsWith('/late-budget')) return response.end(JSON.stringify({ code: 9, payload: Array(10_001).fill(0) }));
    response.end(path.endsWith('/bug') ? '{"code":9}' : path.endsWith('/large') ? JSON.stringify({ code: 0, payload: 'x'.repeat(2048) })
      : '{"code":0,"name":"Heimdall","active":false,"items":[1,2],"nullable":null,"nested":{"toJSON":"business data"}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const targetUrl = 'http://127.0.0.1:' + server.address().port + '/app?token=SECRET';
  let plan;
  if (openapi) {
    const schema = { type: 'object', required: ['code', 'name'], properties: { code: { const: 0 } } };
    const get = () => ({ get: { responses: { 200: { description: 'OK', content: { 'application/json': { schema } } } } } });
    plan = previewOpenApi({ openapi: '3.1.1', info: { title: 'Evidence binding', version: '1' }, paths: { '/healthy': get(), '/bug': get() } }, { targetUrl }).plan;
    plan.spec.approved = true;
  } else {
    const checks = [contract('healthy'), contract('bug'), contract('slow'), contract('large'), contract('head', 'HEAD'), contract('status'), contract('invalid')];
    checks[0].path = '/healthy?tenant=SECRET';
    checks[1].expect.json.push({ pointer: '/missing', kind: 'required' });
    checks[0].expect.json.push({ pointer: '/name', kind: 'required' }, { pointer: '/active', kind: 'equals', value: false },
      { pointer: '/items', kind: 'type', type: 'array' }, { pointer: '/nullable', kind: 'equals', value: null }, { pointer: '/nested', kind: 'type', type: 'object' });
    plan = normalizeSpecPlan({ mode: 'spec', name: 'Evidence binding', targetUrl, timeoutMs: 1000, maxResponseBytes: 1024,
      spec: { source: { id: 'REQ-EVIDENCE', revision: '1', type: 'manual' }, approved: true, checks } });
  }
  plan = normalizeSpecPlan(plan);
  const raw = await runSpecAcceptance(plan, { runId: 'ac-00000000-0000-4000-8000-000000000001', outputDir: root });
  const files = new Map([...new Set(raw.checks.flatMap(check => Object.values(check.evidence)))].sort().map(name => [name, fs.readFileSync(join(root, name))]));
  return { root, plan, raw, files, requests };
}
const validate = (f, raw = f.raw, files = f.files, plan = f.plan) => validateManagedSpecEvidence({ plan, raw, files });

test('real HTTP healthy, BUG, timeout, body budget, HEAD, header and syntax evidence bind without changing verdicts', async t => {
  const f = await fixture(t), before = copy(f.raw), bytesBefore = cloneFiles(f.files);
  assert.equal(validate(f), true); assert.deepEqual(f.raw, before); assert.deepEqual(f.files, bytesBefore);
  assert.deepEqual(f.raw.checks.map(check => check.verdict), ['match', 'bug', 'environment', 'environment', 'match', 'bug', 'bug']);
  assert.equal(f.requests.length, 7); assert.equal(f.raw.checks[2].actual.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(f.raw.checks[3].actual.errorCode, 'RESPONSE_BODY_BUDGET');
  assert.equal(f.raw.checks[4].actual.bodyRead, 'HEAD-has-no-body');
  assert.equal(f.raw.checks[5].actual.bodyRead, 'not-needed-after-header-mismatch');
  assert.equal(f.raw.checks[6].actual.parseError, 'Response is not valid UTF-8 JSON.');
  assert.ok(JSON.parse(f.files.get(f.raw.checks[0].evidence.request)).url.includes('%5Bredacted%5D'));

  await t.test('BUG cannot be relabeled passed even when the raw actual and response evidence still agree', () => {
    const raw = copy(f.raw); raw.checks[1].status = 'passed'; raw.checks[1].verdict = 'match'; rejected(() => validate(f, raw));
    raw.checks[1].actual.mismatches = []; rejected(() => validate(f, raw));
    const files = cloneFiles(f.files); changeFile(files, raw.checks[1].evidence.response, value => { value.mismatches = []; });
    // Even a matched projection cannot erase the separately recorded false
    // assertion while claiming a successful conjunction.
    rejected(() => validate(f, raw, files));
  });
  await t.test('fixed contract, request content and file roles cannot be substituted', () => {
    for (const [role, mutate] of [
      ['contract', value => { value.contract.expect.json[0].value = 9; }], ['contract', value => { value.approved = false; }],
      ['contract', value => { value.source.revision = 'different'; }], ['contract', value => { value.contractFingerprint = 'a'.repeat(64); }],
      ['request', value => { value.method = 'POST'; }], ['request', value => { value.url = 'https://private.invalid'; }],
      ['request', value => { value.redirect = 'follow'; }], ['request', value => { value.headers.Authorization = 'SECRET'; }],
    ]) { const files = cloneFiles(f.files); changeFile(files, f.raw.checks[0].evidence[role], mutate); rejected(() => validate(f, f.raw, files)); }
    for (const role of ['contract', 'request', 'response']) {
      const raw = copy(f.raw); raw.checks[0].evidence[role] = raw.checks[1].evidence[role]; rejected(() => validate(f, raw));
    }
  });
  await t.test('response projection is byte-capture-derived and all reported observations remain bound', () => {
    for (const mutate of [value => { value.httpStatus = 201; }, value => { value.assertions[0].actual = 7; },
      value => { value.assertions[1].actual = 'another string'; }, value => { value.assertions[3].actual = [2, 1]; },
      value => { value.bodySha256 = 'a'.repeat(64); }, value => { value.unexpected = true; },
      value => { value.evaluationLimited = false; }]) {
      const files = cloneFiles(f.files); changeFile(files, f.raw.checks[0].evidence.response, mutate); rejected(() => validate(f, f.raw, files));
    }
    const files = cloneFiles(f.files); changeFile(files, f.raw.checks[2].evidence.response, value => { value.error = 'changed'; }); rejected(() => validate(f, f.raw, files));
  });
  await t.test('missing files, extra files, malformed JSON, UTF-8 and deep evidence fail closed', () => {
    const response = f.raw.checks[0].evidence.response;
    for (const value of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('null'), Buffer.from('{}'),
      Buffer.from('{"requested":true,"mismatches":{},"assertions":[]}'), Buffer.from('{"requested":true,"assertions":[{}]}')]) {
      const files = cloneFiles(f.files); files.set(response, value); rejected(() => validate(f, f.raw, files));
    }
    const missing = cloneFiles(f.files); missing.delete(response); rejected(() => validate(f, f.raw, missing));
    const extra = cloneFiles(f.files); extra.set('unused.json', Buffer.from('{}')); rejected(() => validate(f, f.raw, extra));
    const deep = cloneFiles(f.files); deep.set(response, Buffer.from('['.repeat(81) + '0' + ']'.repeat(81))); rejected(() => validate(f, f.raw, deep));
  });
  await t.test('a real runner deadline cap has fixed unrequested facts and no request/response roles', async () => {
    const originalNow = Date.now, before = f.requests.length; let capped = false;
    try {
      Date.now = () => originalNow() + (capped ? SPEC_LIMITS.runMs + 1 : 0);
      const dir = join(f.root, 'capped');
      const raw = await runSpecAcceptance(f.plan, { runId: f.raw.runId, outputDir: dir, onEvent: event => { if (event.kind === 'acceptance-check') capped = true; } });
      const files = new Map([...new Set(raw.checks.flatMap(check => Object.values(check.evidence)))].map(name => [name, fs.readFileSync(join(dir, name))]));
      assert.equal(validate(f, raw, files), true); assert.equal(raw.coverage.capped, true); assert.equal(f.requests.length - before, 1);
      const wrong = copy(raw); wrong.checks[1].actual.reason = 'other'; rejected(() => validate(f, wrong, files));
      const forged = copy(raw); forged.checks[1].evidence.response = f.raw.checks[1].evidence.response; rejected(() => validate(f, forged, files));
    } finally { Date.now = originalNow; }
  });
  await t.test('a proven BUG remains failed when later schema validation reaches its instance budget', async () => {
    const plan = copy(f.plan); plan.maxResponseBytes = 65_536;
    const check = contract('late-budget'); check.expect.schema = true; plan.spec.checks = [check];
    const normalized = normalizeSpecPlan(plan), dir = join(f.root, 'late-budget');
    const raw = await runSpecAcceptance(normalized, { runId: f.raw.runId, outputDir: dir });
    const files = new Map(Object.values(raw.checks[0].evidence).map(name => [name, fs.readFileSync(join(dir, name))]));
    assert.equal(raw.checks[0].status, 'failed'); assert.equal(raw.checks[0].verdict, 'bug');
    assert.equal(raw.checks[0].evaluationLimited, true); assert.equal(raw.checks[0].actual.errorCode, 'RESPONSE_SCHEMA_BUDGET_EXCEEDED');
    assert.equal(validateManagedSpecEvidence({ plan: normalized, raw, files }), true);
    const changed = copy(raw); changed.checks[0].status = 'blocked'; changed.checks[0].verdict = 'environment'; rejected(() => validate(f, changed, files, normalized));
  });
});

test('real complete OpenAPI healthy/schema BUG bind source bytes and redacted schema failures', async t => {
  const f = await fixture(t, true); assert.equal(validate(f), true);
  const bug = f.raw.checks.find(check => check.verdict === 'bug'); assert.ok(bug.actual.schemaFailures.length > 0);
  assert.ok(bug.actual.schemaFailures.some(failure => failure.actual.type === 'object'));
  assert.equal(f.requests.length, 2);
  for (const mutate of [value => { value.document.info.version = '2'; }, value => { value.source.id = 'other'; }]) {
    const files = cloneFiles(f.files); changeFile(files, 'requirement-source.json', mutate); rejected(() => validate(f, f.raw, files));
  }
  const files = cloneFiles(f.files); changeFile(files, bug.evidence.response, value => { value.schemaFailures[0].actual = 'changed'; }); rejected(() => validate(f, f.raw, files));
  const raw = copy(f.raw); raw.checks.find(check => check.verdict === 'bug').verdict = 'match'; raw.checks.find(check => check.status === 'failed').status = 'passed'; rejected(() => validate(f, raw));
});

test('strict facts and opaque Map byte captures reject hooks, aliases and over-budget input without executing getters', async t => {
  const f = await fixture(t, true); let hooks = 0;
  const hook = () => { hooks++; throw Error('SECRET C:\\private'); };
  const input = () => ({ plan: copy(f.plan), raw: copy(f.raw), files: cloneFiles(f.files) });
  for (const mutate of [value => { Object.defineProperty(value, 'raw', { get: hook, enumerable: true }); },
    value => { Object.defineProperty(value.plan, 'private', { get: hook, enumerable: true }); }, value => { value.raw.toJSON = hook; },
    value => { value.raw[Symbol('private')] = true; }, value => { value.raw.self = value.raw; },
    value => { Object.defineProperty(value.raw, 'private', { value: true }); }, value => { value.plan = new Proxy({}, { get: hook, ownKeys: hook }); },
    value => { value.files = new Proxy(value.files, { get: hook, ownKeys: hook }); },
    value => { Object.defineProperty(value.files, 'entries', { get: hook }); },
    value => { value.files.set('extra.json', new Proxy({}, { get: hook, ownKeys: hook })); },
    value => { value.files.set('extra.json', new Uint8Array(new SharedArrayBuffer(1))); },
    value => { value.files.set('extra.json', Buffer.alloc(64 * 1024 * 1024 + 1)); },
    value => { value.raw.extra = 'x'.repeat(8 * 1024 * 1024); }]) {
    const value = input(); mutate(value); rejected(() => validateManagedSpecEvidence(value));
  }
  rejected(() => validateManagedSpecEvidence(new Proxy({}, { get: hook, ownKeys: hook })));
  const opaque = cloneFiles(f.files);
  for (const bytes of opaque.values()) for (const key of ['buffer', 'length']) Object.defineProperty(bytes, key, { get: hook });
  assert.equal(validate(f, f.raw, opaque), true);
  assert.equal(hooks, 0);
  const changed = cloneFiles(f.files); assert.equal(validate(f, f.raw, changed), true);
  changed.get(f.raw.checks[0].evidence.contract)[0] ^= 1; rejected(() => validate(f, f.raw, changed));
});
