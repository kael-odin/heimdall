import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GEO_METHOD_VERSION } from '../src/seo/method.mjs';

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
      runId, site: 'web', startedAt: '2026-11-11T01:00:00.000Z', endedAt: '2026-11-11T01:00:12.500Z',
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], viewports: ['1440x900'], checks: [] },
      summary: { total: 2, fileable: 1, environment: 0, checkNeedsFix: 0, tolerable: 0, suppressed: 1 },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.overall, 'needs_human_review');
    assert.equal(env.result.readiness.stage, 'human_review');
    assert.equal(env.result.readiness.backend.status, 'needs_human_review');
    assert.equal(env.result.readiness.qa.status, 'needs_human_review');
    assert.equal(env.result.clone.mirrors, 1);
    assert.equal(env.result.seo.score, 92.8);
    assert.equal(env.result.api.contract.summary.endpoints, 1);
    assert.equal(env.result.api.adapter.status, 'validated');
    assert.equal(env.result.api.scaffold.present, false);
    assert.equal(env.result.api.adapter.gapLedger.summary.uniqueGaps, 1);
    assert.equal(env.result.qa.latest.runId, runId);
    assert.equal(env.result.qa.metrics.coverage.runs, 1);
    assert.equal(env.result.qa.metrics.coverage.pageViewportChecks, 1);
    assert.equal(env.result.qa.metrics.runtime.count, 1);
    assert.equal(env.result.qa.metrics.runtime.p50Ms, 12500);
    assert.deepEqual(env.result.qa.metrics.failures.byKind, {});
    assert.equal(env.result.qa.metrics.oracle.status, 'not_provided');
    assert.equal(env.result.qa.metrics.decision.primaryAction, 'collect-more-evidence');
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
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.status, 'available');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.action.args.command, 'heimdall backend scaffold example.test');
    assert.equal(env.result.deliveryPlan.backendCompletion.gapLedger.summary.missingResponseBodies, 1);
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'backend-scaffold'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-adapter-gap-ledger'));
    assert.ok(env.result.deliveryPlan.backendCompletion.humanJourneys.some(item => item.id === 'authentication-and-permission'));
    assert.equal(env.result.deliveryPlan.backendCompletion.provenance.invented.length, 0);
    assert.doesNotMatch(run.stdout, /super-secret/);
    assert.equal(existsSync(join(page, 'network.har')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: recognizes a complete default B3 scaffold', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-scaffold-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  const scaffold = join(root, 'workspace', 'example.test', 'backend-scaffold');
  try {
    put(join(page, 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(page, 'manifest.json'), { target: 'https://example.test/' });
    put(join(root, 'workspace', 'example.test', 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      openapi: { servers: [{ url: 'https://example.test' }], paths: { '/api/items': { get: { responses: { '200': {} } } } } },
    });
    for (const name of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json']) put(join(scaffold, name), '{}');
    put(join(scaffold, 'backend-check.json'), {
      schema: 'heimdall.backend-check/1', generatedAt: '2026-11-12T00:00:00.000Z', overall: 'passed',
      results: [{ id: 'health', status: 'passed' }, { id: 'adapter-coverage', status: 'passed' }],
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.api.scaffold.status, 'present');
    assert.equal(env.result.api.scaffold.check.status, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.check.overall, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'backend-scaffold-check').status, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.status, 'present');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.action, null);
    assert.deepEqual(env.result.deliveryPlan.backendCompletion.repairTasks, []);
    assert.equal(env.result.deliveryPlan.items.some(item => item.id === 'backend-scaffold'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: exposes sanitized backend repair tasks to AI', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-repair-tasks-'));
  const scaffold = join(root, 'workspace', 'example.test', 'backend-scaffold');
  try {
    put(join(root, 'workspace', 'example.test', 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      openapi: { paths: { '/api/items': { get: { responses: { '200': {} } } } } },
    });
    for (const name of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json']) put(join(scaffold, name), '{}');
    put(join(scaffold, 'backend-check.json'), {
      schema: 'heimdall.backend-check/1', generatedAt: '2026-11-12T00:00:00.000Z', overall: 'failed',
      results: [
        {
          id: 'GET /api/items', status: 'failed', reason: '响应 MIME 不一致',
          repairTask: { id: 'repair-get-api-items', kind: 'response-contract', target: 'GET /api/items', instruction: '修正响应 MIME', requiresHumanApproval: false, evidence: { actualMimeType: 'text/plain', secret: 'private-value' } },
        },
        {
          id: 'adapter-gap-ledger', status: 'failed', uniqueGaps: 1, uncoveredQueryParameters: 1, unverifiedWrites: 0,
          repairTask: { id: 'repair-query-parameter-gap', kind: 'query-parameter-gap', target: 'runtime-adapter/index.mjs', instruction: '补齐查询参数分支', requiresHumanApproval: false, evidence: { uniqueGaps: 1, uncoveredQueryParameters: 1 } },
        },
      ],
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const tasks = env.result.deliveryPlan.backendCompletion.repairTasks;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].target, 'GET /api/items');
    assert.equal(tasks[0].kind, 'response-contract');
    assert.equal(tasks[1].kind, 'query-parameter-gap');
    assert.equal(tasks[1].evidence.uncoveredQueryParameters, 1);
    assert.doesNotMatch(run.stdout, /private-value/);
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

test('site-assessment: exposes AI-ready status when only non-blocking actions remain', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-ai-review-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  const qa = join(root, 'qa-project');
  try {
    put(join(page, 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(page, 'manifest.json'), { target: 'https://example.test/' });
    const seoReport = {
      origin: 'https://example.test', generatedAt: '2026-11-11T00:00:00.000Z', score: 100,
      summary: { pages: 1, issues: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      categories: {}, geo: { methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 100, actionPlan: [], coverage: { pages: 1, pagesScored: 1, ratio: 1 } },
    };
    const seoPath = join(root, 'workspace', 'example.test', 'seo', 'seo.json');
    put(seoPath, seoReport);
    put(join(qa, '.heimdall', 'qa.json'), {
      schema: 'heimdall.qa/1', project: 'assessment-test',
      sites: { web: { url: 'https://example.test/', pages: ['/'], environment: 'test' } },
      dataDir: '.heimdall/qa',
    });
    put(join(qa, '.heimdall', 'qa', 'runs', 'qa-20261111-130000-abcd', 'run.json'), {
      runId: 'qa-20261111-130000-abcd', site: 'web', startedAt: '2026-11-11T02:00:00.000Z',
      summary: { total: 1, fileable: 0, environment: 0, checkNeedsFix: 0, tolerable: 0, suppressed: 0 },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.result.overall, 'ready_for_ai_review');
    assert.equal(env.result.readiness.stage, 'ai_review_with_open_actions');
    assert.equal(env.result.readiness.clone.status, 'needs_verification');
    assert.equal(env.result.readiness.seo.status, 'ready');
    assert.equal(env.result.readiness.geo.status, 'ready');
    assert.equal(env.result.readiness.backend.status, 'needs_observation');
    assert.equal(env.result.readiness.qa.status, 'ready');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-contract' && item.status === 'open'));
    for (const geo of [
      undefined,
      { score: 100, actionPlan: [] },
      { ...seoReport.geo, methodVersion: GEO_METHOD_VERSION - 1 },
      { ...seoReport.geo, status: 'partial', coverage: { pages: 1, pagesScored: 1, ratio: 0.92 } },
      { ...seoReport.geo, status: 'unavailable', score: null, coverage: { pages: 1, pagesScored: 0, ratio: 0 } },
    ]) {
      put(seoPath, { ...seoReport, geo });
      const rerun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
        cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
      const result = JSON.parse(rerun.stdout.trim().split(/\r?\n/).at(-1)).result;
      assert.notEqual(result.readiness.geo.status, 'ready');
      assert.equal(result.readiness.geo.basis, result.seo.geo.status === 'unknown' ? 'unknown' : 'observed');
      assert.equal(result.readiness.seo.status, 'needs_follow_up');
      assert.deepEqual(result.seo.geo.coverage, geo?.coverage ?? null);
      assert.ok(result.deliveryPlan.items.some(item => item.id === 'seo-geo-follow-up'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
