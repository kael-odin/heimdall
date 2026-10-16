import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from '../src/acceptance/report.mjs';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun, acceptanceArtifact } from '../src/acceptance/store.mjs';
import { startAcceptanceApiFixture } from './fixtures/acceptance-api.mjs';

const cli = new URL('../src/acceptance/cli.mjs', import.meta.url);
const contract = (path = '/healthy', expect = { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] }) => ({ id: 'API-QUOTA', title: '配额业务成功', method: 'GET', path, severity: 'high', expect });
const plan = (targetUrl = 'http://127.0.0.1:1234', checks = [contract()], spec = {}) => normalizeAcceptancePlan({ schemaVersion: 1, name: 'Spec 验收', mode: 'spec', targetUrl, timeoutMs: 1000,
  spec: { source: { id: 'REQ-QUOTA', revision: 'v1', type: 'manual' }, approved: true, checks, ...spec } });
async function temporary(fn) {
  const outputDir = await mkdtemp(join(tmpdir(), 'heimdall-spec-test-'));
  try { return await fn(outputDir); } finally { await rm(outputDir, { recursive: true, force: true }); }
}

test('Spec normalization rejects unsupported requests, ambiguous expectations and unbounded plans', () => {
  const good = plan();
  assert.equal(good.spec.approved, true);
  assert.equal(normalizeAcceptancePlan(good).targetUrl, good.targetUrl);
  for (const change of [
    { baselineUrl: 'http://unused.test' }, { routes: ['/'] }, { headers: { authorization: 'no' } }, { targetUrl: 'file:///tmp/test' },
    { spec: { ...good.spec, approved: 'true' } }, { spec: { ...good.spec, checks: [] } },
    { spec: { ...good.spec, checks: [contract('/../other')] } },
    { spec: { ...good.spec, checks: [{ ...contract(), method: 'POST' }] } },
    { spec: { ...good.spec, checks: [{ ...contract(), headers: {} }] } },
    { spec: { ...good.spec, checks: [contract('/', { status: 200, json: [{ pointer: '/invalid~2', kind: 'required' }] })] } },
    { spec: { ...good.spec, checks: [contract('/', { status: 200, json: [{ pointer: '/code', kind: 'equals' }] })] } },
    { spec: { ...good.spec, checks: [contract('/', { status: 200, json: [{ pointer: '/code', kind: 'required', value: 0 }] })] } },
    { spec: { ...good.spec, checks: [{ ...contract(), method: 'HEAD' }] } },
    { spec: { ...good.spec, checks: [contract('/', { status: 200, schema: { pattern: '.*' } })] } },
    { spec: { ...good.spec, checks: [contract('/', { contentType: 'application/json' })] } },
    { spec: { ...good.spec, checks: Array.from({ length: 33 }, (_, index) => ({ ...contract(), id: `a${index}` })) } },
  ]) assert.throws(() => normalizeAcceptancePlan({ ...good, ...change }), JSON.stringify(change));
  assert.equal(plan(undefined, [], { omissions: [{ id: 'post', method: 'POST', path: '/write', reason: 'Writing is not supported.' }] }).spec.omissions.length, 1);
});

test('Spec explicitly validates 0, false, required, enum and types without a visual score', async () => temporary(async outputDir => {
  const fixture = await startAcceptanceApiFixture();
  try {
    const input = plan(fixture.targetUrl, [contract('/healthy', { status: 200, contentType: 'application/json', json: [
      { pointer: '/code', kind: 'equals', value: 0 }, { pointer: '/data/active', kind: 'equals', value: true },
      { pointer: '/data/id', kind: 'type', type: 'integer' }, { pointer: '/data/name', kind: 'required' },
      { pointer: '/data/name', kind: 'enum', values: ['Heimdall', 'Other'] },
    ] })]);
    const report = summarizeAcceptanceReport(await runAcceptance(input, { outputDir }));
    assert.equal(report.gate, 'passed');
    assert.equal(report.summary.coverage.ratio, 1);
    assert.equal(report.summary.dimensions.visual.score, null);
    assert.equal(report.checks[0].oracle.kind, 'approved-spec');
    assert.equal(report.specSource.id, 'REQ-QUOTA');
    assert.equal(fixture.requests.length, 1);
    const response = JSON.parse(await readFile(join(outputDir, report.checks[0].evidence.response), 'utf8'));
    assert.equal(response.body.code, 0);
    assert.equal(Object.hasOwn(report.checks[0].actual, 'body'), false);
  } finally { await fixture.close(); }
}));

test('Spec candidate and unsupported operations stay blocked and never request the target', async () => temporary(async outputDir => {
  const fixture = await startAcceptanceApiFixture();
  try {
    const candidate = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [contract()], { approved: false }), { outputDir }));
    assert.equal(candidate.gate, 'blocked');
    assert.equal(candidate.summary.coverage.measured, 0);
    const omitted = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [], { omissions: [{ id: 'delete', path: '/users', method: 'DELETE', reason: 'Not read-only' }] }), { outputDir }));
    assert.equal(omitted.gate, 'blocked');
    assert.equal(omitted.summary.coverage.total, 1);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
}));

test('Spec HTTP 200 business errors are defects, while timeout and size limits remain unmeasured', async () => temporary(async outputDir => {
  const fixture = await startAcceptanceApiFixture();
  try {
    for (const path of ['/wrong-code', '/missing-field', '/wrong-type', '/non-json', '/bad-json', '/wrong-status']) {
      const expect = { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }, { pointer: '/data/name', kind: 'required' }, { pointer: '/data/id', kind: 'type', type: 'integer' }] };
      const report = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [contract(path, expect)]), { outputDir }));
      assert.equal(report.gate, 'failed', path);
      assert.equal(report.checks[0].verdict, 'bug', path);
    }
    for (const path of ['/oversized', '/slow']) {
      const report = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [contract(path)]), { outputDir }));
      assert.equal(report.gate, 'blocked', path);
      assert.equal(report.summary.coverage.measured, 0, path);
      assert.equal(report.checks[0].verdict, 'environment', path);
    }
  } finally { await fixture.close(); }
}));

test('Spec compares observed redirect status without following and supports explicit HEAD/no-body contracts', async () => temporary(async outputDir => {
  const fixture = await startAcceptanceApiFixture();
  try {
    const redirected = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [contract('/redirect')]), { outputDir }));
    assert.equal(redirected.gate, 'failed');
    assert.equal(redirected.checks[0].actual.httpStatus, 302);
    const expectedRedirect = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [contract('/redirect', { status: 302 })]), { outputDir }));
    assert.equal(expectedRedirect.gate, 'passed');
    assert.equal(fixture.requestCounts['/healthy'] ?? 0, 0);
    const head = summarizeAcceptanceReport(await runAcceptance(plan(fixture.targetUrl, [{ ...contract('/head', { status: 200, contentType: 'application/json' }), method: 'HEAD' }]), { outputDir }));
    assert.equal(head.gate, 'passed');
    assert.equal(head.checks[0].actual.bodyRead, 'HEAD-has-no-body');
  } finally { await fixture.close(); }
}));

test('Spec chunked bodies and schema instance budgets cannot be misread as a passing response', async () => temporary(async outputDir => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/chunked') { res.write('{"data":"'); res.end('x'.repeat(2000) + '"}'); }
    else res.end(JSON.stringify(Array.from({ length: 10001 }, () => 0)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const small = { ...plan(base, [contract('/chunked')]), maxResponseBytes: 1024 };
    const limited = summarizeAcceptanceReport(await runAcceptance(small, { outputDir }));
    assert.equal(limited.gate, 'blocked');
    assert.equal(limited.checks[0].actual.errorCode, 'RESPONSE_BODY_BUDGET');
    const schema = summarizeAcceptanceReport(await runAcceptance(plan(base, [contract('/schema', { status: 200, schema: { type: 'array', items: { type: 'integer' } } })]), { outputDir }));
    assert.equal(schema.gate, 'blocked');
    assert.equal(schema.checks[0].actual.errorCode, 'RESPONSE_SCHEMA_BUDGET_EXCEEDED');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('Spec reports persist source, approved contract, evidence hashes and useful Markdown without a fake baseline', async () => temporary(async root => {
  const fixture = await startAcceptanceApiFixture();
  try {
    const input = plan(fixture.targetUrl, [contract('/wrong-code')]);
    const run = createAcceptanceRun(input, { root });
    const raw = await runAcceptance(run.plan, { runId: run.runId, outputDir: acceptanceRunDir(run.runId, root) });
    const report = finishAcceptanceRun(run.runId, raw, { root });
    assert.equal(report.gate, 'failed');
    assert.equal(report.evidenceManifest.length, 3);
    assert.ok(report.evidenceManifest.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(acceptanceArtifact(run.runId, report.checks[0].evidence.response, { root }));
    const markdown = acceptanceMarkdown(report);
    assert.match(markdown, /REQ-QUOTA/);
    assert.match(markdown, /契约指纹/);
    assert.doesNotMatch(markdown, /基线：未测/);
    assert.match(markdown, /spec-1-API-QUOTA-response\.json/);
  } finally { await fixture.close(); }
}));

test('Spec report summaries exclude root response payloads and retain known bugs if later validation is limited', async () => temporary(async outputDir => {
  const secret = 'fixture-private-secret';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/large' ? { code: 400, items: Array(10001).fill(0) } : { code: 0, accessToken: secret, nested: { privateText: secret } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const privateReport = summarizeAcceptanceReport(await runAcceptance(plan(base, [contract('/private', { status: 200, json: [{ pointer: '', kind: 'type', type: 'object' }, { pointer: '/accessToken', kind: 'type', type: 'string' }] })]), { outputDir }));
    assert.equal(privateReport.gate, 'passed');
    assert.doesNotMatch(JSON.stringify(privateReport), new RegExp(secret));
    assert.match(await readFile(join(outputDir, privateReport.checks[0].evidence.response), 'utf8'), new RegExp(secret));
    const known = summarizeAcceptanceReport(await runAcceptance(plan(base, [contract('/large', { status: 200, json: [{ pointer: '/code', kind: 'equals', value: 0 }], schema: { type: 'object' } })]), { outputDir }));
    assert.equal(known.gate, 'failed');
    assert.equal(known.checks[0].verdict, 'bug');
    assert.equal(known.checks[0].actual.evaluationLimited, true);
    assert.equal(known.checks[0].actual.errorCode, 'RESPONSE_SCHEMA_BUDGET_EXCEEDED');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('Spec CLI --gate returns nonzero for a contract defect and draft, and zero only for passing contracts', async () => temporary(async root => {
  const fixture = await startAcceptanceApiFixture();
  try {
    for (const [path, approved, expectedExit] of [['/healthy', true, 0], ['/wrong-code', true, 1], ['/healthy', false, 1]]) {
      const dataDir = await mkdtemp(join(root, 'cli-'));
      const { writeFile } = await import('node:fs/promises');
      const inputPath = join(dataDir, 'plan.json');
      await writeFile(inputPath, JSON.stringify(plan(fixture.targetUrl, [contract(path)], { approved })));
      let actualExit = 0;
      try { await promisify(execFile)(process.execPath, [fileURLToPath(cli), '--plan', inputPath, '--gate'], { env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, timeout: 20000 }); }
      catch (error) { actualExit = error.code; }
      assert.equal(actualExit, expectedExit, `${path}, approved=${approved}`);
      const runs = await readdir(join(dataDir, 'acceptance'));
      assert.equal(runs.length, 1);
    }
  } finally { await fixture.close(); }
}));
