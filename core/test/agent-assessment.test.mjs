import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin', 'heimdall.mjs');

function put(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

test('site-assessment: aggregates sanitized evidence and keeps unknowns explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  const site = join(root, 'workspace', 'example.test');
  const qa = join(root, 'qa-project');
  const runId = 'qa-20261111-120000-abcd';
  try {
    put(join(page, 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(page, 'manifest.json'), { target: 'https://example.test/' });
    put(join(page, 'network.har'), { secret: 'super-secret' });
    put(join(page, 'session.json'), { token: 'super-secret' });
    put(join(page, 'operation-plan.json'), { value: 'super-secret' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', generatedAt: '2026-11-11T00:00:00.000Z', score: 92.8,
      summary: { pages: 1, issues: 2, bySeverity: { high: 1, low: 1 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      categories: { index: { score: 100, issues: 0 } }, geo: { score: 80, actionPlan: [{ priority: 'P1' }] },
    });
    put(join(site, 'api-contract.json'), {
      tier: 'B1', openapi: { servers: [{ url: 'https://example.test' }], paths: { '/api/items': { get: {
        'x-heimdall-observations': { samples: 2, queryParams: ['page'] },
        responses: { '200': { 'x-heimdall-samples': 2, content: { 'application/json': { schema: { type: 'object' } } } } },
      } } } },
      observations: [{ withResponseSchema: true, withRequestSchema: false, authSchemes: ['bearer'], errorSamples: 1 }],
      unknowns: [{ kind: 'auth-unknown' }],
    });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/items' }] });
    put(join(site, 'runtime-adapter', 'index.mjs'), 'export const secret = "super-secret"; export async function handle() { return new Response("ok"); }');
    put(join(site, 'adapter-report.json'), {
      results: { status: 'passed', equivalence: 1, heldout: 1, passed: 1, failed: 0, unverified: 0 },
      gapLedger: {
        schema: 'heimdall.adapter-gap-ledger/1', source: 'offline-observation', status: 'offline-observed',
        summary: { runtimeRequests: 0, uniqueGaps: 1, unobservedPaths: 0, uncoveredQueryParameters: 1, missingResponseBodies: 1, unverifiedWrites: 1 },
        knownRoutes: [{ method: 'GET', path: '/api/items', queryParams: ['page'], responseBody: 'unavailable', writeVerification: 'not_applicable' }],
        gaps: [{ method: 'GET', path: '/api/items', queryParams: ['cursor'], count: 1, categories: ['uncovered-query-parameter'], nearestRoutes: [] }],
        unknowns: ['authentication-permission-unknown', 'business-state-unknown', 'missing-response-body', 'unverified-write'],
      },
    });
    put(join(qa, '.heimdall', 'qa.json'), {
      schema: 'heimdall.qa/1', project: 'assessment-test',
      sites: { web: { url: 'https://example.test/', pages: ['/'], environment: 'test' } },
      dataDir: '.heimdall/qa',
    });
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'run.json'), {
      runId, site: 'web', startedAt: '2026-11-11T01:00:00.000Z',
      summary: { total: 2, fileable: 1, environment: 0, checkNeedsFix: 0, tolerable: 0, suppressed: 1 },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.overall, 'ready_for_ai_review');
    assert.equal(env.result.clone.mirrors, 1);
    assert.equal(env.result.seo.score, 92.8);
    assert.equal(env.result.api.contract.summary.endpoints, 1);
    assert.equal(env.result.api.adapter.status, 'validated');
    assert.equal(env.result.api.adapter.gapLedger.summary.uniqueGaps, 1);
    assert.equal(env.result.qa.latest.runId, runId);
    assert.ok(env.result.claims.verified.includes('api.adapter_holdout:1'));
    assert.ok(env.result.unknowns.some(item => item.id === 'auth-permissions-state-unknown'));
    assert.equal(env.result.deliveryPlan.schema, 'heimdall.site-delivery-plan/1');
    assert.equal(env.result.deliveryPlan.decision.basis, 'inferred');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'clone-visual-verification'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'seo-geo-follow-up'));
    assert.equal(env.result.deliveryPlan.items.find(item => item.id === 'api-behavior-unknown').status, 'blocked');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'qa-findings'));
    assert.equal(env.result.deliveryPlan.backendCompletion.schema, 'heimdall.backend-completion-task/1');
    assert.equal(env.result.deliveryPlan.backendCompletion.observedEndpoints[0].path, '/api/items');
    assert.equal(env.result.deliveryPlan.backendCompletion.verifiedResponseShapes.count, 1);
    assert.equal(env.result.deliveryPlan.backendCompletion.verifiedResponseShapes.verificationStatus, 'replay_holdout_passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.gapLedger.summary.missingResponseBodies, 1);
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-adapter-gap-ledger'));
    assert.ok(env.result.deliveryPlan.backendCompletion.humanJourneys.some(item => item.id === 'authentication-and-permission'));
    assert.equal(env.result.deliveryPlan.backendCompletion.provenance.invented.length, 0);
    assert.doesNotMatch(run.stdout, /super-secret/);
    assert.equal(existsSync(join(page, 'network.har')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: delivery plan keeps capture and missing evidence separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-plan-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  try {
    put(join(page, 'manifest.json'), { target: 'https://example.test/' });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.overall, 'needs_capture');
    assert.equal(env.result.deliveryPlan.decision.stage, 'capture');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'clone-mirror-coverage' && item.basis === 'observed'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'seo-report' && item.basis === 'unknown'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-contract' && item.basis === 'unknown'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'qa-workspace' && item.status === 'blocked'));
    assert.equal(env.result.deliveryPlan.backendCompletion.status, 'blocked_on_observation');
    assert.equal(env.result.deliveryPlan.backendCompletion.observedEndpoints.length, 0);
    assert.ok(env.result.deliveryPlan.backendCompletion.suggestedLocalFiles.some(item => item.path.endsWith('backend-state-rules.json')));
    assert.doesNotMatch(run.stdout, /super-secret|network\.har|operation-plan\.json/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
