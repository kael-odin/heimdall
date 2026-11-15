import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GEO_METHOD_VERSION, SEO_MEASUREMENT_VERSION, SEO_SCORE_METHOD_VERSION } from '../src/seo/method.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin', 'heimdall.mjs');

function put(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

test('site-assessment: zero fileable findings do not hide incomplete QA evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-qa-'));
  const qa = join(root, 'qa-project');
  const summary = { total: 0, fileable: 0, environment: 0, checkNeedsFix: 0 };
  const coverage = {
    pages: [{ path: '/', viewport: '1440x900', counts: {} }], checks: [],
    detection: { enabled: true, pages: 1, findings: 2, failedPages: [], detectors: ['a11y-heading'] },
    baseline: { status: 'disabled' },
  };
  try {
    put(join(root, 'workspace', 'example.test', 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(qa, '.heimdall', 'qa.json'), { sites: { web: { url: 'https://example.test/', pages: ['/'] } } });
    const runId = 'qa-20261113-120000-abcd';
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'report.md'), '# QA report');
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'bugs.md'), '# QA findings');
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'findings.json'), []);
    for (const [name, patch, status] of [
      ['unverified check', { summary: { ...summary, checkNeedsFix: 1 } }, 'incomplete'],
      ['complete', {}, 'complete'],
      ['environment', { summary: { ...summary, environment: 1 } }, 'incomplete'],
      ['page request blocked', { coverage: { ...coverage, pages: [{ counts: { clientBlocked: 1 } }] } }, 'incomplete'],
      ['check request blocked', { coverage: { ...coverage, checks: [{ clientBlocked: 1 }] } }, 'incomplete'],
      ['navigation failed', { coverage: { ...coverage, pages: [{ navError: 'assessment-private-marker' }] } }, 'incomplete'],
      ['detector failed', { coverage: { ...coverage, detection: { failedPages: [{}] } } }, 'incomplete'],
      ['baseline unavailable', { coverage: { ...coverage, baseline: { status: 'incomplete', skipped: [{ incomplete: true, reason: 'assessment-private-marker' }] } } }, 'incomplete'],
      ['bounded coverage', { coverage: {
        ...coverage,
        pages: Array.from({ length: 51 }, (_, index) => ({ path: `/page-${index}`, viewport: '1440x900', counts: {} })),
        checks: Array.from({ length: 51 }, (_, index) => ({ id: `check-${index}`, pass: true, clientBlocked: 0 })),
      } }, 'complete'],
      ['malformed business check', { coverage: { ...coverage, checks: [{ id: 'checkout', pass: 'yes' }] } }, 'unknown'],
      ['summary only', { coverage: undefined }, 'unknown'],
      ['malformed coverage', { coverage: { ...coverage, pages: [null] } }, 'unknown'],
      ['missing counters', { summary: { fileable: 0 } }, 'unknown'],
      ['negative counter', { summary: { ...summary, environment: -1 } }, 'unknown'],
      ['findings and incomplete', { summary: { ...summary, fileable: 1, checkNeedsFix: 1 } }, 'incomplete'],
    ]) {
      put(join(qa, '.heimdall', 'qa', 'runs', runId, 'run.json'), { runId, site: 'web', summary, coverage, ...patch });
      const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
        cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
      assert.ok(existsSync(join(qa, result.qa.latest.report)), 'QA report reference must resolve');
      assert.ok(existsSync(join(qa, result.qa.latest.bugs)), 'QA findings reference must resolve');
      assert.equal(result.readiness.qa.status, status === 'complete' ? 'ready' : 'needs_human_review', name);
      assert.equal(result.qa.latest.completeness.status, status, name);
      assert.equal(result.deliveryPlan.items.some(item => item.id === 'qa-incomplete' && item.status === 'blocked'), status !== 'complete', name);
      if (name === 'complete') {
        assert.deepEqual(result.qa.latest.coverage.detection, {
          enabled: true, pages: 1, findings: 2, failedPages: 0, detectors: ['a11y-heading'],
        });
        assert.deepEqual(result.qa.latest.coverage.businessChecks, { status: 'not_declared', total: 0 });
        assert.match(result.deliveryPlan.qaTask.prompt, /latest\.coverage\.detection/);
        assert.match(result.deliveryPlan.qaTask.prompt, /latest\.coverage\.businessChecks/);
        assert.ok(result.deliveryPlan.qaTask.tasks.some(item => item.id === 'add-business-checks'));
        assert.ok(result.deliveryPlan.items.some(item => item.id === 'qa-business-checks' && item.status === 'open'));
      }
      if (name === 'bounded coverage') {
        assert.equal(result.qa.latest.coverage.pages.length, 50);
        assert.equal(result.qa.latest.coverage.pagesTotal, 51);
        assert.deepEqual(result.qa.latest.coverage.pagesMeta, { total: 51, valid: 51, returned: 50, truncated: true });
        assert.equal(result.qa.latest.coverage.checks.length, 50);
        assert.deepEqual(result.qa.latest.coverage.checksMeta, { total: 51, returned: 50, truncated: true });
        assert.match(result.deliveryPlan.qaTask.prompt, /pagesMeta/);
      }
      if (name === 'malformed business check') {
        assert.deepEqual(result.qa.latest.coverage.businessChecks, { status: 'incomplete', total: 1 });
        assert.ok(result.deliveryPlan.qaTask.tasks.some(item => item.id === 'complete-qa-run'));
        assert.ok(result.deliveryPlan.qaTask.tasks.some(item => item.id === 'complete-business-checks'));
        assert.equal(result.deliveryPlan.items.find(item => item.id === 'qa-business-checks').status, 'blocked');
      }
      if (name === 'findings and incomplete') assert.ok(result.deliveryPlan.items.some(item => item.id === 'qa-findings'));
      assert.doesNotMatch(run.stdout, /assessment-private-marker/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: does not borrow QA evidence from an unrelated workspace site', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-qa-scope-'));
  const qa = join(root, 'qa-project');
  try {
    put(join(root, 'workspace', 'example.test', 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(root, 'workspace', 'example.test', 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(qa, '.heimdall', 'qa.json'), {
      sites: { unrelated: { url: 'https://unrelated.test/', pages: ['/'] } },
    });
    put(join(qa, '.heimdall', 'qa', 'runs', 'qa-unrelated-20261115-abcd', 'run.json'), {
      runId: 'qa-unrelated-20261115-abcd', site: 'unrelated', startedAt: '2026-11-15T00:00:00.000Z',
      summary: { total: 1, fileable: 0, environment: 0, checkNeedsFix: 0 },
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], checks: [] },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.qa.status, 'configured');
    assert.equal(result.qa.site, null);
    assert.equal(result.qa.latest, null);
    assert.equal(result.readiness.qa.status, 'needs_human_review');
    assert.equal(result.deliveryPlan.items.find(item => item.id === 'qa-workspace').status, 'blocked');
    assert.doesNotMatch(run.stdout, /qa-unrelated-20261115-abcd|unrelated\.test/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: blocks QA readiness when finding details are unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-qa-finding-summary-'));
  const qa = join(root, 'qa-project');
  const runPath = join(qa, '.heimdall', 'qa', 'runs', 'qa-summary-20261115-abcd', 'run.json');
  try {
    put(join(root, 'workspace', 'example.test', 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(root, 'workspace', 'example.test', 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(qa, '.heimdall', 'qa.json'), {
      sites: { web: { url: 'https://example.test/', pages: ['/'] } },
    });
    put(runPath, {
      runId: 'qa-summary-20261115-abcd', site: 'web', startedAt: '2026-11-15T00:00:00.000Z',
      summary: { total: 1, fileable: 1, environment: 0, checkNeedsFix: 0 },
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], checks: [], detection: { failedPages: [] }, baseline: { status: 'disabled' } },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.qa.latest.completeness.status, 'complete');
    assert.equal(result.qa.latest.findings.status, 'unavailable');
    assert.equal(result.qa.latest.findings.total, 1);
    assert.equal(result.qa.latest.report, null);
    assert.equal(result.qa.latest.bugs, null);
    assert.equal(result.deliveryPlan.qaTask.latest.findings.status, 'unavailable');
    assert.deepEqual(result.deliveryPlan.qaTask.inputs, []);
    assert.equal(result.deliveryPlan.qaTask.status, 'blocked_on_qa_evidence');
    assert.ok(result.deliveryPlan.qaTask.tasks.some(item => item.id === 'obtain-finding-evidence'));
    assert.equal(result.readiness.qa.status, 'needs_human_review');
    assert.equal(result.deliveryPlan.items.find(item => item.id === 'qa-finding-evidence').status, 'blocked');

    put(runPath, {
      runId: 'qa-summary-20261115-abcd', site: 'web', startedAt: '2026-11-15T00:00:00.000Z',
      summary: { total: 0, fileable: 0, environment: 0, checkNeedsFix: 0 },
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], checks: [], detection: { failedPages: [] }, baseline: { status: 'disabled' } },
    });

    const emptySummaryRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(emptySummaryRun.status, 0, emptySummaryRun.stderr + emptySummaryRun.stdout);
    const { result: emptySummary } = JSON.parse(emptySummaryRun.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(emptySummary.qa.latest.findings.total, 0);
    assert.equal(emptySummary.deliveryPlan.qaTask.status, 'blocked_on_qa_evidence');
    assert.equal(emptySummary.readiness.qa.status, 'needs_human_review');
    assert.equal(emptySummary.deliveryPlan.items.find(item => item.id === 'qa-finding-evidence').status, 'blocked');

    put(join(qa, '.heimdall', 'qa', 'runs', 'qa-summary-20261115-abcd', 'findings.json'), []);
    put(runPath, {
      runId: 'qa-summary-20261115-abcd', site: 'web', startedAt: '2026-11-15T00:00:00.000Z',
      summary: { total: 1, fileable: 1, environment: 0, checkNeedsFix: 0 },
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], checks: [], detection: { failedPages: [] }, baseline: { status: 'disabled' } },
    });
    const inconsistentRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(inconsistentRun.status, 0, inconsistentRun.stderr + inconsistentRun.stdout);
    const { result: inconsistent } = JSON.parse(inconsistentRun.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(inconsistent.qa.latest.findings.status, 'inconsistent');
    assert.equal(inconsistent.qa.latest.findings.reportedTotal, 1);
    assert.equal(inconsistent.qa.latest.findings.total, 0);
    assert.equal(inconsistent.deliveryPlan.qaTask.status, 'blocked_on_qa_evidence');
    assert.equal(inconsistent.deliveryPlan.items.find(item => item.id === 'qa-finding-evidence').title, 'QA finding 摘要与详情不一致');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: rejects SEO and API evidence from a different origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-origin-scope-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://unrelated.test', score: 100,
      summary: { pages: 1, issues: 0, bySeverity: {}, sitemapCoverage: 'complete' },
    });
    put(join(site, 'api-contract.json'), {
      origin: 'https://unrelated.test', openapi: { paths: { '/api/items': { get: { responses: { '200': {} } } } } },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.origin, 'https://example.test');
    assert.equal(result.seo.status, 'invalid');
    assert.equal(result.seo.reason, 'origin_mismatch');
    assert.equal(result.deliveryPlan.seoGeoTask.status, 'blocked_on_observation');
    assert.equal(result.api.contract.status, 'invalid');
    assert.equal(result.api.contract.reason, 'origin_mismatch');
    assert.ok(result.unknowns.some(item => item.id === 'api-contract-invalid'));
    assert.match(result.deliveryPlan.items.find(item => item.id === 'api-contract').detail, /来源与当前站点页面来源不一致/);
    assert.doesNotMatch(run.stdout, /unrelated\.test/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: scans every page before accepting an origin anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-origin-all-pages-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    for (let index = 1; index <= 21; index++) {
      const page = join(site, 'pages', `page-${String(index).padStart(2, '0')}`);
      put(join(page, 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
      put(join(page, 'manifest.json'), {
        target: `https://${index === 21 ? 'unrelated.test' : 'example.test'}/page-${index}`,
      });
    }
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 100,
      summary: { pages: 21, issues: 0, bySeverity: {}, sitemapCoverage: 'complete' },
    });
    put(join(site, 'api-contract.json'), {
      origin: 'https://example.test',
      openapi: { paths: { '/api/items': { get: { responses: { '200': {} } } } } },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.origin, null);
    assert.equal(result.seo.status, 'invalid');
    assert.equal(result.seo.reason, 'origin_ambiguous');
    assert.equal(result.api.contract.status, 'invalid');
    assert.equal(result.api.contract.reason, 'origin_ambiguous');
    assert.match(result.deliveryPlan.items.find(item => item.id === 'api-contract').detail, /多个 origin/);
    assert.doesNotMatch(run.stdout, /unrelated\.test/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: preserves bounded sitemap reasons for SEO follow-up', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-sitemap-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 90,
      summary: { pages: 1, issues: 0, bySeverity: {}, sitemapCoverage: 'partial' },
      sitemap: {
        coverage: 'partial', reasons: ['budget-exhausted', 'private-value'],
        stats: { sitemapFilesAttempted: 3, sitemapFilesRead: 3, sitemapFilesFailed: 0, urlCount: 10000,
          truncated: ['url-limit', 'private-value'], limits: { maxUrls: 10000, maxFiles: 100 } },
      },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(result.seo.sitemap.reasons, ['budget-exhausted']);
    assert.deepEqual(result.seo.sitemap.truncated, ['url-limit']);
    assert.equal(result.seo.sitemap.stats.urlCount, 10000);
    assert.equal(result.seo.sitemap.stats.maxUrls, 10000);
    assert.match(result.deliveryPlan.items.find(item => item.id === 'seo-geo-follow-up').detail, /budget-exhausted/);
    assert.ok(result.unknowns.some(item => item.id === 'seo-sitemap-scope-limited' && /budget-exhausted/.test(item.detail)));
    assert.doesNotMatch(run.stdout, /private-value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 1, issues: 2, bySeverity: { high: 1, low: 1 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      categories: { index: { score: 100, issues: 0 } }, geo: {
        score: 80,
        dimensions: {
          answerability: { label: '可回答性', score: 70, weight: 30, pages: 1, observedWeight: 30, totalWeight: 30, status: 'complete' },
          citation: { label: '引用准备度', score: 90, weight: 20, pages: 1, observedWeight: 20, totalWeight: 20, status: 'complete' },
        },
        actionPlan: [{ rank: 1, id: 'geo-citation-description', dimension: 'citation', priority: 'P1',
          title: '摘要有值', action: '补充真实摘要；Bearer private-value 不应泄露。',
          impact: { checkWeight: 4, affectedPages: 1, occurrences: 1 }, estimatedEffort: 'small',
          validation: { method: 'rerun-geo-audit', checkId: 'geo-citation-description', expectedStatus: 'pass' },
          affectedPages: ['https://example.test/?token=private-value'], evidence: [{ message: 'private-value' }] }],
      },
      pages: [{ url: 'https://example.test/', issues: [
        { id: 'content-title-missing', category: 'content', severity: 'high', title: '缺少 title', suggestion: '补充准确的 title' },
        { id: 'perf-weight-large', category: 'perf', severity: 'medium', title: '页面体积过大', suggestion: '压缩资源' },
      ] }],
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
        summary: { runtimeRequests: 0, uniqueGaps: 1, unobservedPaths: 1, unobservedQueryVariants: 1, uncoveredQueryParameters: 1, missingResponseBodies: 1, unverifiedWrites: 1 },
        knownRoutes: [{ method: 'GET', path: '/api/items', queryParams: ['page'], responseBody: 'unavailable', writeVerification: 'not_applicable' }],
        gaps: [{ method: 'GET', path: '/api/items', queryParams: ['cursor'], count: 1, categories: ['uncovered-query-parameter'], nearestRoutes: [] }],
        unknowns: ['authentication-permission-unknown', 'business-state-unknown', 'missing-response-body', 'unverified-write'],
      },
    });
    put(join(site, 'live-export.json'), {
      schema: 'heimdall.live-export/1', siteId: 'example.test', generatedAt: '2026-11-11T02:00:00.000Z',
      status: 'passed', published: true, offline: true, strict: true, root: 'mirror', pages: 1,
      blockingCount: 0, blockers: {}, healthReport: 'deliverable/.candidate-example.test-Ab1234/health.json',
      browser: { checked: 1, failed: 0, untested: 0, totalPages: 1 },
      coverage: { scope: 'recon-discovered', scopeLimited: false },
    });
    put(join(root, 'deliverable', '.candidate-example.test-Ab1234', 'health.json'), {
      adapter: { serverEgress: 'not-tested', declaredRoutes: 1, exercisedRoutes: 1, untestedRoutes: 0 },
    });
    put(join(qa, '.heimdall', 'qa.json'), {
      schema: 'heimdall.qa/1', project: 'assessment-test',
      sites: { web: { url: 'https://example.test/', pages: ['/'], environment: 'test' } },
      dataDir: '.heimdall/qa',
    });
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'run.json'), {
      runId, site: 'web', startedAt: '2026-11-11T01:00:00.000Z', endedAt: '2026-11-11T01:00:12.500Z',
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], viewports: ['1440x900'], checks: [] },
      summary: { total: 2, fileable: 2, environment: 0, checkNeedsFix: 0, tolerable: 0, suppressed: 0 },
    });
    put(join(qa, '.heimdall', 'qa', 'runs', runId, 'findings.json'), [
      {
        id: 'F1', fingerprint: 'fp_qa1', tier: 'wall', basis: 'failed', kind: 'network', path: '/api/items',
        title: '接口泄露 token=private-value', target: '/api/items?token=private-value',
        observed: 'Authorization: Bearer abcdefghijkl', confidence: 'observed', source: 'check',
        triage: { status: 'new' },
      },
      {
        id: 'F2', fingerprint: 'fp_qa2', tier: 'degrade', basis: 'wrong', kind: 'a11y', path: '/checkout',
        title: '输入框没有标签', target: '#email', observed: '控件缺少可访问名称',
        confidence: 'observed', source: 'check', triage: { status: 'known-bug', verdict: 'bug', reason: '无障碍问题已确认' },
      },
    ]);

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
    assert.equal(env.result.seo.geo.actionPlan[0].id, 'geo-citation-description');
    assert.equal(env.result.seo.geo.actionPlan[0].validation.checkId, 'geo-citation-description');
    assert.equal(env.result.seo.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(env.result.seo.measurementVersion, SEO_MEASUREMENT_VERSION);
    assert.equal(env.result.seo.geo.actionPlanMeta.truncated, false);
    assert.equal(env.result.deliveryPlan.seoGeoTask.schema, 'heimdall.seo-geo-ai-task/1');
    assert.equal(env.result.deliveryPlan.seoGeoTask.status, 'ready_for_ai_review');
    assert.equal(env.result.deliveryPlan.seoGeoTask.scores.seo, 92.8);
    assert.equal(env.result.deliveryPlan.seoGeoTask.scores.geo, 80);
    assert.equal(env.result.seo.geo.dimensions.answerability.score, 70);
    assert.equal(env.result.deliveryPlan.seoGeoTask.scores.geoDimensions.citation.status, 'complete');
    assert.deepEqual(env.result.deliveryPlan.seoGeoTask.observedActions.map(item => item.id), [
      'content-title-missing', 'geo-citation-description',
    ]);
    assert.deepEqual(env.result.deliveryPlan.seoGeoTask.observedAdvisories.map(item => item.id), ['perf-weight-large']);
    assert.equal(env.result.deliveryPlan.seoGeoTask.provenance.invented.length, 0);
    assert.match(env.result.deliveryPlan.seoGeoTask.prompt, /不要把分数解释为排名/);
    assert.doesNotMatch(run.stdout, /private-value/);
    assert.equal(env.result.api.contract.summary.endpoints, 1);
    assert.equal(env.result.api.adapter.status, 'validated');
    assert.equal(env.result.api.scaffold.present, false);
    assert.equal(env.result.api.adapter.gapLedger.summary.uniqueGaps, 1);
    assert.equal(env.result.clone.delivery.adapter.serverEgress, 'not-tested');
    assert.equal(env.result.deliveryPlan.backendCompletion.adapterEgress.status, 'not-tested');
    assert.equal(env.result.deliveryPlan.backendCompletion.adapterEgress.operationProbe.status, 'not-tested');
    assert.ok(env.result.deliveryPlan.backendCompletion.unknowns.some(item => item.id === 'adapter-server-egress'));
    assert.ok(env.result.deliveryPlan.backendCompletion.unknowns.some(item => item.id === 'adapter-operation-probe'));
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'offline-egress').status, 'blocked');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'operation-probe').status, 'not-tested');
    assert.equal(env.result.qa.latest.runId, runId);
    assert.equal(env.result.qa.latest.findings.status, 'observed');
    assert.equal(env.result.qa.latest.findings.total, 2);
    assert.equal(env.result.qa.latest.findings.returned, 2);
    assert.equal(env.result.qa.latest.findings.items[0].verification.status, 'pending_human_verdict');
    assert.equal(env.result.qa.latest.findings.items[0].verification.method, 'heimdall_qa_findings');
    assert.equal(env.result.qa.latest.findings.items[0].target, '/api/items?[sensitive value removed]');
    const qaRepairTasks = env.result.deliveryPlan.items.find(item => item.id === 'qa-findings').repairTasks;
    assert.equal(qaRepairTasks.length, 2);
    assert.equal(qaRepairTasks[0].status, 'blocked_on_human_verdict');
    assert.equal(qaRepairTasks[0].requiresHumanApproval, true);
    assert.equal(qaRepairTasks[0].evidence.fingerprint, 'fp_qa1');
    assert.equal(qaRepairTasks[0].verification.tool, 'heimdall_qa_run');
    assert.match(qaRepairTasks[0].verification.condition, /fingerprint/);
    assert.equal(qaRepairTasks[1].status, 'ready_for_fix');
    assert.equal(qaRepairTasks[1].requiresHumanApproval, false);
    assert.equal(qaRepairTasks[1].evidence.triage, 'known-bug');
    assert.equal(env.result.qa.latest.report, null);
    assert.equal(qaRepairTasks[1].evidence.report, undefined);
    assert.doesNotMatch(run.stdout, /private-value|abcdefghijkl/);
    assert.equal(env.result.qa.metrics.coverage.runs, 1);
    assert.equal(env.result.qa.metrics.coverage.pageViewportChecks, 1);
    assert.equal(env.result.qa.metrics.runtime.count, 1);
    assert.equal(env.result.qa.metrics.runtime.p50Ms, 12500);
    assert.deepEqual(env.result.qa.metrics.failures.byKind, {});
    assert.equal(env.result.qa.metrics.oracle.status, 'not_provided');
    assert.equal(env.result.qa.metrics.decision.primaryAction, 'collect-more-evidence');
    assert.equal(env.result.deliveryPlan.qaTask.schema, 'heimdall.qa-bug-ai-task/1');
    assert.equal(env.result.deliveryPlan.qaTask.status, 'human_review');
    assert.equal(env.result.deliveryPlan.qaTask.scope.frontend.pages, 1);
    assert.equal(env.result.deliveryPlan.qaTask.scope.backend.contract, 'observed');
    assert.equal(env.result.deliveryPlan.qaTask.scope.backend.completion.status, 'needs_human_journey');
    assert.equal(env.result.deliveryPlan.qaTask.scope.backend.completion.currentLevel, 'B1_to_B2_bridge');
    assert.equal(env.result.deliveryPlan.qaTask.scope.backend.completion.observedEndpoints, 1);
    assert.equal(env.result.deliveryPlan.qaTask.scope.backend.completion.gapLedger.uniqueGaps, 1);
    assert.ok(env.result.deliveryPlan.qaTask.scope.backend.completion.humanJourneys.some(item => item.id === 'authentication-and-permission'));
    assert.match(env.result.deliveryPlan.qaTask.prompt, /scope\.backend\.completion/);
    assert.deepEqual(env.result.deliveryPlan.qaTask.latest.coverage.pages, [
      { path: '/', viewport: '1440x900', navigation: 'observed', clientBlocked: 0 },
    ]);
    assert.equal(env.result.deliveryPlan.qaTask.latest.coverage.checksTotal, 0);
    assert.equal(env.result.deliveryPlan.qaTask.latest.findings.status, 'observed');
    assert.equal(env.result.deliveryPlan.qaTask.latest.findings.total, 2);
    assert.ok(env.result.deliveryPlan.qaTask.tasks.some(item => item.id === 'review-findings'));
    assert.ok(env.result.deliveryPlan.qaTask.tasks.some(item => item.id === 'fix-confirmed-findings'));
    assert.equal(env.result.deliveryPlan.qaTask.provenance.invented.length, 0);
    assert.match(env.result.deliveryPlan.qaTask.prompt, /不要把 finding 数量当准确率/);
    assert.doesNotMatch(run.stdout, /private-value|abcdefghijkl/);
    const qaDecision = env.result.deliveryPlan.items.find(item => item.id === 'qa-metrics-decision');
    assert.equal(qaDecision.status, 'open');
    assert.equal(qaDecision.action.tool, 'heimdall_qa_metrics');
    assert.equal(qaDecision.action.args.site, 'web');
    assert.equal(qaDecision.verify.tool, 'heimdall_qa_metrics');
    assert.match(qaDecision.detail, /正常样本|oracle/);
    assert.equal(env.result.readiness.qa.nextAction.tool, 'heimdall_qa_findings');
    assert.ok(env.result.claims.verified.includes('api.adapter_holdout:1'));
    assert.ok(env.result.unknowns.some(item => item.id === 'auth-permissions-state-unknown'));
    assert.equal(env.result.deliveryPlan.schema, 'heimdall.site-delivery-plan/1');
    assert.equal(env.result.deliveryPlan.decision.basis, 'inferred');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'clone-visual-verification'));
    const seoTask = env.result.deliveryPlan.items.find(item => item.id === 'seo-geo-follow-up');
    assert.ok(seoTask);
    assert.equal(seoTask.repairTasks.length, 2);
    assert.equal(seoTask.repairTasks[0].kind, 'seo-action');
    assert.equal(seoTask.repairTasks[0].target, 'content-title-missing');
    assert.equal(seoTask.repairTasks[0].evidence.affectedPages, 1);
    assert.equal(seoTask.repairTasks[0].verification.tool, 'heimdall_seo_audit');
    assert.equal(seoTask.repairTasks[1].kind, 'seo-geo-action');
    assert.equal(seoTask.repairTasks[1].target, 'geo-citation-description');
    assert.equal(seoTask.repairTasks[1].evidence.affectedPages, 1);
    assert.equal(seoTask.repairTasks[1].verification.tool, 'heimdall_seo_audit');
    assert.equal(seoTask.repairTasksTruncated, false);
    assert.equal(env.result.deliveryPlan.items.find(item => item.id === 'api-behavior-unknown').status, 'blocked');
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'qa-findings'));
    assert.equal(env.result.deliveryPlan.backendCompletion.schema, 'heimdall.backend-completion-task/1');
    assert.equal(env.result.deliveryPlan.backendCompletion.observedEndpoints[0].path, '/api/items');
    assert.equal(env.result.deliveryPlan.backendCompletion.verifiedResponseShapes.count, 1);
    assert.equal(env.result.deliveryPlan.backendCompletion.verifiedResponseShapes.verificationStatus, 'replay_holdout_passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.status, 'available');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.action.args.command, 'heimdall backend scaffold example.test');
    assert.equal(env.result.deliveryPlan.backendCompletion.gapLedger.summary.missingResponseBodies, 1);
    assert.deepEqual(env.result.deliveryPlan.backendCompletion.repairTasks.map(item => item.kind), [
      'response-body-evidence', 'write-verification', 'query-variant-gap', 'query-parameter-gap', 'runtime-gap',
    ]);
    assert.equal(env.result.deliveryPlan.backendCompletion.repairTasks[1].verification.condition,
      'api.adapter.gapLedger.summary.unverifiedWrites === 0');
    assert.equal(env.result.deliveryPlan.backendCompletion.repairTasks[0].requiresHumanApproval, true);
    assert.equal(env.result.deliveryPlan.backendCompletion.repairTasks[2].verification.args.siteId, 'example.test');
    assert.match(env.result.deliveryPlan.items.find(item => item.id === 'api-adapter-gap-ledger').detail, /未验证写入 1 条/);
    assert.match(env.result.deliveryPlan.items.find(item => item.id === 'api-adapter-gap-ledger').verify.condition, /unverifiedWrites === 0/);
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'backend-scaffold'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-adapter-gap-ledger'));
    assert.ok(env.result.deliveryPlan.backendCompletion.humanJourneys.some(item => item.id === 'authentication-and-permission'));
    assert.equal(env.result.deliveryPlan.backendCompletion.provenance.invented.length, 0);
    assert.doesNotMatch(run.stdout, /super-secret/);
    assert.doesNotMatch(run.stdout, /private-value/);
    assert.equal(existsSync(join(page, 'network.har')), true);

    const bundle = join(root, 'deliverable', 'example.test-live-2026-11-14');
    const bundleFile = join(bundle, 'README.txt');
    put(bundleFile, 'current-bundle');
    const checksumsPath = join(bundle, 'checksums.json');
    put(checksumsPath, { files: [{ p: 'README.txt', s: readFileSync(bundleFile).length, h: createHash('sha256').update(readFileSync(bundleFile)).digest('hex') }] });
    const checksumsSha256 = createHash('sha256').update(readFileSync(checksumsPath)).digest('hex');
    put(join(site, 'adapter-egress-verification.json'), {
      schema: 'heimdall.adapter-egress-verification/1', siteId: 'example.test',
      generatedAt: '2026-11-14T02:00:00.000Z', serverEgress: 'verified',
      bundle: 'deliverable/example.test-live-2026-11-14', bundleChecksumsSha256: checksumsSha256,
      docker: { network: 'none' }, checks: {
        health: 'passed', stateVolume: 'passed', operationProbe: {
          scope: 'final-image-filesystem', planSha256: 'a'.repeat(64),
          planned: 1, checked: 1, failed: 0, untested: 0, passedFlows: 1,
        },
      },
      adapter: { declaredRoutes: 1, exercisedRoutes: 1, untestedRoutes: 0 },
      httpChecks: {
        beforeRestart: { checked: 1, passed: 1, results: [{ id: 'create', status: 201 }] },
        afterRestart: { checked: 1, passed: 1, results: [{ id: 'readback', status: 200 }] },
      },
    });
    const verifiedRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(verifiedRun.status, 0, verifiedRun.stderr + verifiedRun.stdout);
    const verified = JSON.parse(verifiedRun.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(verified.clone.delivery.adapter.serverEgress, 'verified');
    assert.equal(verified.deliveryPlan.backendCompletion.adapterEgress.operationProbe.status, 'passed');
    assert.equal(verified.deliveryPlan.backendCompletion.adapterEgress.operationProbe.passedFlows, 1);
    assert.deepEqual(verified.deliveryPlan.backendCompletion.adapterEgress.evidence, [
      'workspace/example.test/adapter-egress-verification.json',
    ]);
    assert.equal(verified.deliveryPlan.backendCompletion.adapterEgress.httpChecks.afterRestart.results[0].id, 'readback');
    assert.equal(verified.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'offline-egress').status, 'passed');
    assert.equal(verified.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'operation-probe').status, 'passed');
    assert.equal(verified.deliveryPlan.backendCompletion.unknowns.some(item => item.id === 'adapter-operation-probe'), false);

    const published = JSON.parse(readFileSync(join(site, 'live-export.json'), 'utf8'));
    published.healthReport = null;
    put(join(site, 'live-export.json'), published);
    const publishedRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(publishedRun.status, 0, publishedRun.stderr + publishedRun.stdout);
    const publishedAssessment = JSON.parse(publishedRun.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(publishedAssessment.clone.delivery.adapter.serverEgress, 'verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: marks combined SEO/GEO action truncation explicitly', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-seo-truncation-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    const issues = Array.from({ length: 20 }, (_, index) => ({
      id: `seo-high-${String(index + 1).padStart(2, '0')}`, category: 'content', severity: 'high',
      title: `SEO issue ${index + 1}`, suggestion: '修复当前页面',
    }));
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 80,
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 1, issues: 21, bySeverity: { high: 20 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      pages: [{ url: 'https://example.test/', issues }],
      geo: {
        methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 90,
        actionPlan: [{ rank: 1, id: 'geo-one', dimension: 'citation', priority: 'P1', title: 'GEO action', action: '补充可核实摘要', impact: { affectedPages: 1 }, validation: { method: 'rerun-geo-audit', checkId: 'geo-one' } }],
      },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const task = result.deliveryPlan.seoGeoTask;
    assert.equal(task.observedActions.length, 20);
    assert.equal(task.observedActionsMeta.total, 21);
    assert.equal(task.observedActionsMeta.returned, 20);
    assert.equal(task.observedActionsMeta.truncated, true);
    assert.equal(task.coverage.actionsTruncated, true);
    assert.equal(task.observedAdvisoriesMeta.truncated, false);
    assert.match(task.prompt, /observedActionsMeta/);
    assert.equal(task.status, 'ready_for_ai_review');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: site SEO advisories retain affected pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-seo-site-pages-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 92,
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 2, issues: 1, bySeverity: { medium: 1 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      siteIssues: [{ id: 'content-description-duplicate', category: 'content', severity: 'medium', title: 'description 重复', suggestion: '为每个页面编写独立描述', pages: ['https://example.test/', 'https://example.test/about'] }],
      geo: { methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 100, actionPlan: [] },
    });
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const advisory = result.deliveryPlan.seoGeoTask.observedAdvisories.find(item => item.id === 'content-description-duplicate');
    assert.equal(advisory.affectedPages, 2);
    assert.deepEqual(advisory.pages, ['/', '/about']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: truncated observed actions cannot become ready', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-seo-truncated-ready-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 100,
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 1, issues: 0, bySeverity: {}, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      geo: {
        methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 100, confidence: 'high', actionPlan: [],
        actionPlanMeta: { total: 1, returned: 0, truncated: true }, coverage: { pages: 1, pagesScored: 1, pagesUnavailable: 0, observedWeight: 96, totalWeight: 96, ratio: 1 },
      },
    });
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.deliveryPlan.seoGeoTask.observedActions.length, 0);
    assert.equal(result.deliveryPlan.seoGeoTask.observedActionsMeta.truncated, true);
    assert.equal(result.deliveryPlan.seoGeoTask.status, 'ready_for_ai_review');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: exposes backend gap-ledger truncation metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-gap-ledger-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'api-contract.json'), { origin: 'https://example.test', openapi: { paths: {} } });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [] });
    put(join(site, 'runtime-adapter', 'index.mjs'), 'export async function handle() { return new Response("ok"); }');
    put(join(site, 'adapter-report.json'), {
      results: { status: 'passed', equivalence: 1, heldout: 1, passed: 1, failed: 0, unverified: 0 },
      gapLedger: {
        schema: 'heimdall.adapter-gap-ledger/1', source: 'offline-observation', status: 'offline-observed',
        summary: { runtimeRequests: 51, uniqueGaps: 51, unobservedPaths: 51, unobservedQueryVariants: 0, uncoveredQueryParameters: 0, missingResponseBodies: 0, unverifiedWrites: 0 },
        knownRoutes: Array.from({ length: 201 }, (_, index) => ({ method: 'GET', path: `/api/items/${index}`, queryParams: [], responseBody: 'observed', writeVerification: 'not_applicable' })),
        gaps: Array.from({ length: 51 }, (_, index) => ({ method: 'GET', path: `/api/missing/${index}`, queryParams: [], count: 1, categories: ['unobserved-path'], nearestRoutes: [] })),
        unknowns: Array.from({ length: 11 }, (_, index) => `unknown-${index}`),
      },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const ledger = result.api.adapter.gapLedger;
    assert.deepEqual(ledger.gapsMeta, { total: 51, returned: 50, truncated: true });
    assert.deepEqual(ledger.knownRoutesMeta, { total: 201, returned: 200, truncated: true });
    assert.deepEqual(ledger.unknownsMeta, { total: 11, returned: 10, truncated: true });
    assert.deepEqual(result.deliveryPlan.backendCompletion.gapLedger.gapsMeta, ledger.gapsMeta);
    assert.equal(result.api.adapter.gapLedger.gaps.length, 50);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe contract persists one sanitized contract so site-assessment can read its B0/B1 status', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-probe-contract-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  try {
    put(join(page, 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(page, 'manifest.json'), { target: 'https://example.test/' });
    put(join(root, 'workspace', 'example.test', 'read-data-plan.json'), {
      version: 1, paths: ['/api/items?page=1'],
    });
    put(join(page, 'network.har'), { log: { entries: [{
      request: { method: 'GET', url: 'https://example.test/api/items?page=1' },
      response: { status: 200, content: { mimeType: 'application/json', text: '{"items":[{"id":1}]}' } },
    }] } });

    const probe = spawnSync(process.execPath, [BIN, 'probe', 'contract', '--site', 'example.test', '--include-readonly-data', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(probe.status, 0, probe.stderr + probe.stdout);
    const probeEnv = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(probeEnv.ok, true);
    assert.equal(probeEnv.result.persisted.length, 1);
    assert.equal(existsSync(join(root, 'workspace', 'example.test', 'api-contract.json')), true);
    assert.doesNotMatch(readFileSync(join(root, 'workspace', 'example.test', 'api-contract.json'), 'utf8'), /page=1/);

    const assessment = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(assessment.status, 0, assessment.stderr + assessment.stdout);
    const result = JSON.parse(assessment.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(result.api.contract.status, 'observed');
    assert.equal(result.api.contract.summary.endpoints, 1);
    assert.equal(result.api.contract.path, 'workspace/example.test/api-contract.json');
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
      openapi: { servers: [{ url: 'https://example.test' }], paths: { '/api/items': { get: {
        requestBody: { content: { 'application/json': { schema: true } } },
        responses: {
          '200': { content: { 'application/json': { schema: false } } },
          '400': { content: { 'application/json': { schema: null } } },
        },
      } } } },
    });
    for (const name of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json', 'backend-task.json']) put(join(scaffold, name), {
      schema: name === 'backend-task.json' ? 'heimdall.backend-ai-task/1' : undefined,
      status: name === 'backend-task.json' ? 'ready_for_ai_draft' : undefined,
    });
    put(join(scaffold, 'backend-check.json'), {
      schema: 'heimdall.backend-check/1', generatedAt: '2026-11-12T00:00:00.000Z', overall: 'passed',
      results: [{ id: 'health', status: 'passed' }, { id: 'adapter-coverage', status: 'passed' }],
    });
    put(join(scaffold, 'backend-compare.json'), {
      schema: 'heimdall.backend-comparison/1', mode: 'business-rules-only', overall: 'passed',
      sourceRules: 1, candidateRules: 1, summary: { compared: 1, passed: 1, failed: 0, incomplete: 0 },
      comparisons: [{ id: 'business-rule:read-items', status: 'passed', sourceStatus: 'passed', candidateStatus: 'passed' }],
      repairTasks: [],
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.api.scaffold.status, 'present');
    assert.equal(env.result.api.scaffold.aiTask.status, 'present');
    assert.equal(env.result.api.scaffold.check.status, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.check.overall, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'backend-scaffold-check').status, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.businessRuleComparison.overall, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'business-rule-equivalence').status, 'passed');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.status, 'present');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.aiTask.status, 'present');
    assert.equal(env.result.deliveryPlan.backendCompletion.scaffold.action, null);
    const [endpoint] = env.result.deliveryPlan.backendCompletion.observedEndpoints;
    assert.equal(endpoint.requestBody.withSchema, true);
    assert.deepEqual(endpoint.responseShapes.map(shape => shape.withSchema), [true, false]);
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
      schema: 'heimdall.backend-check/1', generatedAt: '2026-11-12T00:00:00.000Z', mode: 'business-rules-only', overall: 'failed',
      results: [
        {
          id: 'GET /api/items', status: 'failed', reason: '响应 MIME 不一致',
          repairTask: { id: 'repair-get-api-items', kind: 'response-contract', target: 'GET /api/items', instruction: '修正响应 MIME', requiresHumanApproval: false, evidence: { actualMimeType: 'text/plain', secret: 'private-value' } },
        },
        {
          id: 'adapter-gap-ledger', status: 'failed', uniqueGaps: 1, unobservedQueryVariants: 1, uncoveredQueryParameters: 1, unverifiedWrites: 0,
          repairTask: { id: 'repair-query-parameter-gap', kind: 'query-parameter-gap', target: 'runtime-adapter/index.mjs', instruction: '补齐查询参数分支', requiresHumanApproval: false, evidence: { uniqueGaps: 1, unobservedQueryVariants: 1, uncoveredQueryParameters: 1 } },
        },
        {
          id: 'business-rule:create-item', status: 'failed', step: 1, pointer: '/created', reason: 'json_assertion',
          repairTask: { id: 'repair-business-rules', kind: 'business-rule', target: 'state-rules.json', instruction: '修正业务规则', requiresHumanApproval: false, evidence: { reason: 'json_assertion', pointer: '/created', secret: 'private-value' } },
        },
      ],
    });
    put(join(scaffold, 'backend-compare.json'), {
      schema: 'heimdall.backend-comparison/1', mode: 'business-rules-only', overall: 'failed',
      sourceRules: 1, candidateRules: 1, summary: { compared: 1, passed: 0, failed: 1, incomplete: 0 },
      comparisons: [{ id: 'business-rule:create-item', status: 'failed', reason: 'candidate_rule_not_passed', sourceStatus: 'passed', candidateStatus: 'failed', step: 1, pointer: '/created' }],
      repairTasks: [{ id: 'repair-backend-rule-equivalence-create-item-1', kind: 'business-rule-equivalence', target: 'candidate backend', instruction: '修正候选业务流程', requiresHumanApproval: false, evidence: { ruleId: 'business-rule:create-item', sourceStatus: 'passed', candidateStatus: 'failed', step: 1, pointer: '/created', secret: 'private-value' } }],
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const tasks = env.result.deliveryPlan.backendCompletion.repairTasks;
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0].target, 'GET /api/items');
    assert.equal(tasks[0].kind, 'response-contract');
    assert.equal(tasks[1].kind, 'query-parameter-gap');
    assert.equal(tasks[1].evidence.unobservedQueryVariants, 1);
    assert.equal(tasks[1].evidence.uncoveredQueryParameters, 1);
    assert.equal(tasks[2].kind, 'business-rule');
    assert.equal(tasks[2].evidence.pointer, '/created');
    assert.equal(tasks[3].kind, 'business-rule-equivalence');
    assert.equal(tasks[3].evidence.ruleId, 'business-rule:create-item');
    assert.equal(tasks[3].evidence.candidateStatus, 'failed');
    assert.deepEqual(env.result.api.scaffold.check.issuesMeta, { total: 3, returned: 3, truncated: false });
    assert.deepEqual(env.result.api.scaffold.check.repairTasksMeta, { total: 3, returned: 3, truncated: false });
    assert.equal(env.result.deliveryPlan.backendCompletion.businessRules.status, 'failed');
    assert.equal(env.result.deliveryPlan.backendCompletion.businessRules.mode, 'business-rules-only');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'backend-scaffold-check').status, 'not-tested');
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'business-rules').status, 'failed');
    assert.equal(env.result.deliveryPlan.backendCompletion.businessRuleComparison.overall, 'failed');
    assert.deepEqual(env.result.api.scaffold.check.businessRuleComparison.comparisonsMeta, { total: 1, returned: 1, truncated: false });
    assert.deepEqual(env.result.api.scaffold.check.businessRuleComparison.repairTasksMeta, { total: 1, returned: 1, truncated: false });
    assert.equal(env.result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'business-rule-equivalence').status, 'failed');
    assert.doesNotMatch(run.stdout, /private-value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: keeps write verification open when the runtime has no new path gap', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-write-gap-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      openapi: { paths: { '/api/items': { post: {
        responses: { '201': {} },
        'x-heimdall-observations': { samples: 1 },
      } } } },
    });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [{ method: 'POST', path: '/api/items' }] });
    put(join(site, 'runtime-adapter', 'index.mjs'), 'export async function handle() { return new Response(null, { status: 201 }); }');
    put(join(site, 'adapter-report.json'), {
      results: { status: 'passed', equivalence: 1, heldout: 1, passed: 1, failed: 0, unverified: 0 },
      gapLedger: {
        schema: 'heimdall.adapter-gap-ledger/1', source: 'offline-observation', status: 'offline-observed',
        summary: { runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, unobservedQueryVariants: 0, uncoveredQueryParameters: 0, missingResponseBodies: 0, unverifiedWrites: 1 },
        knownRoutes: [{ method: 'POST', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'unverified' }],
        gaps: [], unknowns: ['authentication-permission-unknown', 'business-state-unknown', 'unverified-write'],
      },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.deepEqual(result.deliveryPlan.backendCompletion.repairTasks.map(item => item.kind), ['write-verification']);
    assert.equal(result.deliveryPlan.backendCompletion.repairTasks[0].requiresHumanApproval, true);
    assert.ok(result.deliveryPlan.items.some(item => item.id === 'api-adapter-gap-ledger'));
    assert.match(result.deliveryPlan.items.find(item => item.id === 'api-adapter-gap-ledger').verify.condition, /unverifiedWrites === 0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: keeps query gaps open when unique path gaps are zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-query-gap-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      openapi: { paths: { '/api/items': { get: { responses: { '200': {} } } } } },
    });
    put(join(site, 'runtime-adapter', 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/items' }] });
    put(join(site, 'runtime-adapter', 'index.mjs'), 'export async function handle() { return new Response("{}", { headers: { "content-type": "application/json" } }); }');
    put(join(site, 'adapter-report.json'), {
      results: { status: 'passed', equivalence: 1, heldout: 1, passed: 1, failed: 0, unverified: 0 },
      gapLedger: {
        schema: 'heimdall.adapter-gap-ledger/1', source: 'offline-observation', status: 'offline-observed',
        summary: { runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, unobservedQueryVariants: 1, uncoveredQueryParameters: 1, missingResponseBodies: 0, unverifiedWrites: 0 },
        knownRoutes: [{ method: 'GET', path: '/api/items', queryParams: ['page'], responseBody: 'observed', writeVerification: 'not_applicable' }],
        gaps: [{ method: 'GET', path: '/api/items', queryParams: ['cursor'], count: 1, categories: ['uncovered-query-parameter'] }],
        unknowns: ['query-variant-gap', 'uncovered-query-parameter'],
      },
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.ok(result.api.unknowns.includes('adapter-query-gaps'));
    assert.equal(result.deliveryPlan.backendCompletion.verification.deterministicChecks.find(item => item.id === 'adapter-gap-ledger').status, 'open');
    assert.ok(result.deliveryPlan.backendCompletion.repairTasks.some(item => item.kind === 'query-variant-gap'));
    assert.ok(result.deliveryPlan.backendCompletion.repairTasks.some(item => item.kind === 'query-parameter-gap'));
    const gapItem = result.deliveryPlan.items.find(item => item.id === 'api-adapter-gap-ledger');
    assert.equal(gapItem.status, 'open');
    assert.match(gapItem.detail, /未覆盖查询参数 1 个/);
    assert.match(gapItem.verify.condition, /unobservedQueryVariants === 0/);
    assert.match(gapItem.verify.condition, /uncoveredQueryParameters === 0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: keeps offline delivery outcomes separate from visual and business evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-assessment-delivery-'));
  const site = join(root, 'workspace', 'example.test');
  const outcome = {
    schema: 'heimdall.live-export/1', siteId: 'example.test', generatedAt: '2026-11-12T00:00:00.000Z',
    status: 'blocked', published: false, offline: true, strict: true, root: 'mirror', pages: 1,
    blockingCount: 5, blockers: { unresolved: 1, browserFailed: 1, readOnlyDataMissing: 1, 'super-secret': 2 },
    healthReport: 'deliverable/.candidate-example.test-Ab1234/health.json',
    browser: { checked: 1, failed: 1, untested: 0, totalPages: 1 },
    coverage: { scope: 'recon-discovered', scopeLimited: true }, note: 'super-secret',
  };
  const assessEnvelope = value => {
    if (value) put(join(site, 'live-export.json'), value);
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.doesNotMatch(run.stdout, /super-secret/);
    return JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  };
  const assess = value => assessEnvelope(value).result;
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>mirror</html>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'deliverable', '.candidate-example.test-Ab1234', 'health.json'), {
      browserProbe: {
        capabilities: {
          pagesObserved: 1, signalPages: 1, pagesTruncated: false,
          totals: { iframes: 1, externalIframes: 1, shadowRoots: 1, canvases: 1, tallPages: 0 },
          pages: [{ page: '/library/', iframeCount: 1, externalIframeCount: 1, shadowRootCount: 1, canvasCount: 1 }],
        },
        failures: [
          { page: '/library/', kind: 'pageError', error: 'ReferenceError', message: 'CodeMirror is not defined' },
          { page: '/library/', kind: 'http', status: 404, resourceType: 'script', target: '/missing.js' },
          { page: '/library/', kind: 'externalRequest', target: 'https://analytics.example.test/pixel', message: 'externalRequest' },
        ],
      },
      runtimeDataGaps: [
        { page: '/library/', target: '/api/search', resourceType: 'fetch', failureKind: 'http', status: 404 },
        { page: '/library/', target: '/api/search', resourceType: 'fetch', failureKind: 'http', status: 404 },
      ],
      runtimeDataGapsTruncated: false,
      missingLinkDetails: [
        { path: '/library.db', kind: 'resource-link', references: 1, pages: ['/library/'] },
        { path: '/legacy.doc', kind: 'resource-link', references: 1, pages: ['/library/'] },
      ],
      readOnlyData: { status: 'ok', declared: 2, included: 1, missing: 1, binaryDeclared: 1, binaryIncluded: 0 },
      adapter: { serverEgress: 'not-tested', declaredRoutes: 1, exercisedRoutes: 1, untestedRoutes: 0 },
    });
    assert.equal(assess().readiness.delivery.status, 'needs_export');
    const blockedEnvelope = assessEnvelope(outcome);
    const blocked = blockedEnvelope.result;
    assert.equal(blocked.nextActionsMeta.returned, blockedEnvelope.nextActions.length);
    assert.equal(blocked.nextActionsMeta.truncated, blocked.nextActionsMeta.total > blocked.nextActionsMeta.returned);
    assert.equal(blocked.nextActionsMeta.truncated, true);
    assert.equal(blocked.clone.delivery.status, 'blocked');
    assert.equal(blocked.clone.delivery.blockingCount, 5);
    assert.equal(blocked.clone.delivery.otherBlockers, 2);
    assert.deepEqual(blocked.clone.delivery.blockers, { unresolved: 1, browserFailed: 1, readOnlyDataMissing: 1 });
    assert.equal(blocked.clone.delivery.healthReport, outcome.healthReport);
    assert.equal(blocked.clone.delivery.adapter.serverEgress, 'not-tested');
    assert.equal(blocked.clone.delivery.browserFailures[0].message, 'CodeMirror is not defined');
    assert.equal(blocked.clone.delivery.browserFailures[1].resourceType, 'script');
    assert.deepEqual(blocked.clone.delivery.browserCapabilities.totals,
      { iframes: 1, externalIframes: 1, shadowRoots: 1, canvases: 1, tallPages: 0 });
    assert.deepEqual(blocked.deliveryPlan.cloneTask.scope.delivery.browserCapabilities.pages,
      [{ page: '/library/', iframeCount: 1, externalIframeCount: 1, shadowRootCount: 1, canvasCount: 1 }]);
    assert.equal(blocked.clone.delivery.browserCapabilities.support.overall, 'unsupported');
    assert.equal(blocked.clone.delivery.browserCapabilities.support.signals.find(item => item.id === 'externalIframes').status, 'unsupported');
    assert.equal(blocked.clone.delivery.browserCapabilities.support.signals.find(item => item.id === 'canvases').status, 'degraded');
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-page-complexity').status, 'open');
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-page-complexity').detail, /shadowRoots=1/);
    assert.equal(blocked.clone.delivery.runtimeDataGaps[0].target, '/api/search');
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-runtime-data-gaps').repairTasks.length, 1);
    assert.equal(blocked.deliveryPlan.backendCompletion.runtimeDataGaps[0].failureKind, 'http');
    assert.equal(blocked.deliveryPlan.backendCompletion.repairTasks.some(item => item.kind === 'runtime-data-observation'), true);
    assert.equal(assess({ ...outcome, healthReport: '/super-secret/health.json' }).clone.delivery.healthReport, null);
    assert.equal(blocked.readiness.delivery.status, 'blocked');
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-offline-delivery').status, 'blocked');
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-browser-failures').status, 'blocked');
    const nextActionKeys = blockedEnvelope.nextActions.map(item => JSON.stringify({ tool: item.tool, args: item.args ?? null }));
    assert.equal(new Set(nextActionKeys).size, nextActionKeys.length);
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-browser-failures').detail, /CodeMirror is not defined/);
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-browser-failures').detail, /2 条本地失败证据/);
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-browser-failures').verify.condition, /externalRequest/);
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-external-runtime').status, 'blocked');
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-external-runtime').detail, /analytics\.example\.test/);
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-external-runtime').verify.method, 'human_authorized_external_runtime_review');
    assert.equal(blocked.clone.delivery.binaryDownloadGaps[0].path, '/library.db');
    assert.equal(blocked.clone.delivery.binaryDownloadGaps[1].path, '/legacy.doc');
    assert.deepEqual(blocked.clone.delivery.readOnlyData, {
      status: 'ok', declared: 2, included: 1, missing: 1, binaryDeclared: 1, binaryIncluded: 0,
    });
    assert.equal(blocked.deliveryPlan.items.find(item => item.id === 'clone-binary-downloads').status, 'blocked');
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-binary-downloads').detail, /library\.db/);
    assert.match(blocked.deliveryPlan.items.find(item => item.id === 'clone-binary-downloads').detail, /--include-readonly-binaries/);
    assert.match(blocked.readiness.delivery.nextAction.args.command, /--root mirror$/);
    put(join(root, 'deliverable', '.candidate-example.test-Ab1234', 'health.json'), {
      browserProbe: {
        failures: [],
        capabilities: {
          pagesObserved: 1, signalPages: 1, pagesTruncated: false,
          totals: { iframes: 0, externalIframes: 0, shadowRoots: 0, canvases: 1, tallPages: 0 },
          pages: [{ page: '/library/', canvasCount: 1 }],
        },
      },
    });
    const passed = { ...outcome, status: 'passed', published: true, blockingCount: 0, blockers: {},
      browser: { checked: 1, failed: 0, untested: 0, totalPages: 1 } };
    const accepted = assess(passed);
    assert.equal(accepted.clone.delivery.browserCapabilities.support.overall, 'supported');
    assert.equal(accepted.clone.delivery.browserCapabilities.support.signals[0].status, 'supported');
    assert.equal(accepted.readiness.delivery.status, 'last_check_passed');
    assert.equal(accepted.readiness.delivery.basis, 'observed');
    assert.equal(accepted.readiness.clone.status, 'needs_verification');
    assert.equal(accepted.readiness.clone.scope.status, 'needs_scope_review');
    assert.equal(accepted.readiness.clone.scopeLimited, true);
    assert.equal(accepted.readiness.clone.scope.nextAction.args.allDiscovered, true);
    assert.equal(accepted.clone.delivery.coverage.scopeLimited, true);
    assert.equal(accepted.deliveryPlan.cloneTask.status, 'blocked_on_visual_verification');
    assert.equal(accepted.deliveryPlan.cloneTask.scope.delivery.coverage.scopeLimited, true);
    assert.equal(accepted.deliveryPlan.items.find(item => item.id === 'clone-scope-limited').status, 'open');
    assert.equal(accepted.deliveryPlan.items.find(item => item.id === 'clone-scope-limited').action.args.allDiscovered, true);
    assert.match(accepted.deliveryPlan.cloneTask.verification.commands[0], /--all-discovered$/);
    assert.equal(accepted.claims.observed.includes('clone.offline_export:passed'), true);
    assert.equal(accepted.claims.verified.some(claim => claim.includes('offline')), false);
    assert.equal(accepted.deliveryPlan.items.some(item => item.id === 'clone-offline-delivery'), false);
    assert.equal(accepted.deliveryPlan.items.some(item => item.id === 'clone-browser-failures'), false);
    const full = assess({ ...passed, coverage: { scope: 'recon-discovered', scopeLimited: false } });
    assert.equal(full.readiness.clone.status, 'needs_verification');
    assert.equal(full.readiness.clone.scope.status, 'ready');
    assert.equal(full.readiness.clone.scopeLimited, false);
    assert.equal(assess({ ...passed, status: 'unverified', strict: false, browser: null }).readiness.delivery.status, 'needs_strict_verification');
    for (const invalid of [
      { ...passed, siteId: 'other.test' }, { ...passed, strict: false }, { ...passed, published: false },
      { ...passed, blockers: { unresolved: 1 } }, { ...passed, browser: null },
      { ...passed, browser: { ...passed.browser, checked: 0 } },
    ]) assert.equal(assess(invalid).clone.delivery.status, 'invalid');
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
    assert.equal(env.result.deliveryPlan.qaTask.status, 'blocked_on_qa_evidence');
    assert.equal(env.result.deliveryPlan.backendCompletion.status, 'blocked_on_observation');
    assert.equal(env.result.deliveryPlan.backendCompletion.observedEndpoints.length, 0);
    assert.ok(env.result.deliveryPlan.backendCompletion.suggestedLocalFiles.some(item => item.path.endsWith('backend-state-rules.json')));
    assert.doesNotMatch(run.stdout, /super-secret|network\.har|operation-plan\.json/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: accepts current static deployment evidence only when the bundle checksum matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-static-deployment-'));
  const site = join(root, 'workspace', 'example.test');
  const bundle = join(root, 'deliverable', 'example.test-live-2026-11-14');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>mirror</html>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'live-export.json'), {
      schema: 'heimdall.live-export/1', siteId: 'example.test', generatedAt: '2026-11-14T00:00:00.000Z',
      status: 'passed', published: true, offline: true, strict: true, root: 'mirror', pages: 1,
      blockingCount: 0, blockers: {}, browser: { checked: 1, failed: 0, untested: 0, totalPages: 1 },
      coverage: { scope: 'captured-only', scopeLimited: true },
    });
    const files = {
      'health.json': JSON.stringify({ adapter: { status: 'not-included' }, offline: true }),
      'Dockerfile': 'FROM node:22-alpine',
      'serve.mjs': 'console.log(1)',
      'heimdall-live.json': JSON.stringify({ siteId: 'example.test', port: 8080 }),
      'site/live/index.html': '<!doctype html><h1>Example</h1>',
    };
    for (const [name, body] of Object.entries(files)) put(join(bundle, name), body);
    put(join(bundle, 'checksums.json'), { files: Object.entries(files).map(([p, body]) => ({
      p, s: Buffer.byteLength(body), h: createHash('sha256').update(body).digest('hex'),
    })) });
    const checksumsSha256 = createHash('sha256').update(readFileSync(join(bundle, 'checksums.json'))).digest('hex');
    put(join(site, 'deployment-verification.json'), {
      schema: 'heimdall.static-deployment-verification/1', siteId: 'example.test',
      generatedAt: '2026-11-14T01:00:00.000Z', deployment: 'verified',
      bundle: 'deliverable/example.test-live-2026-11-14', bundleChecksumsSha256: checksumsSha256,
      docker: { network: 'none' }, checks: {
        health: 'passed', root: 'passed', routes: { checked: 1, failed: 0 }, sourceWorkspace: 'passed', restart: 'passed',
        browserProbe: { scope: 'final-image-filesystem', bundleChecksumsSha256: checksumsSha256,
          checked: 1, failed: 0, untested: 0, truncated: false, failureCount: 0 },
      },
    });
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.clone.delivery.deploymentVerification.status, 'verified');
    assert.equal(result.readiness.independentDeployment.status, 'verified');
    assert.equal(result.clone.delivery.deploymentVerification.browserProbe.checked, 1);
    assert.ok(result.claims.verified.includes('clone.independent_deployment:network_none'));
    assert.equal(result.deliveryPlan.items.some(item => item.id === 'independent-deployment'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: exposes a failed deployment attempt without treating it as pass evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-deployment-attempt-'));
  const site = join(root, 'workspace', 'example.test');
  const bundle = join(root, 'deliverable', 'example.test-live-2026-11-15');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<html>mirror</html>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'live-export.json'), {
      schema: 'heimdall.live-export/1', siteId: 'example.test', generatedAt: '2026-11-15T01:00:00.000Z',
      status: 'blocked', published: false, offline: true, strict: true, root: 'mirror', pages: 1,
      blockingCount: 1, blockers: { browserFailed: 1 }, browser: { checked: 1, failed: 1, untested: 0, totalPages: 1 },
      coverage: { scope: 'recon-discovered', scopeLimited: true },
    });
    const files = {
      'health.json': JSON.stringify({ adapter: { status: 'not-included' }, offline: true }),
      'Dockerfile': 'FROM node:22-alpine',
      'serve.mjs': 'console.log(1)',
      'heimdall-live.json': JSON.stringify({ siteId: 'example.test', port: 8080 }),
      'site/live/index.html': '<!doctype html><h1>Example</h1>',
    };
    for (const [name, body] of Object.entries(files)) put(join(bundle, name), body);
    put(join(bundle, 'checksums.json'), { files: Object.entries(files).map(([p, body]) => ({
      p, s: Buffer.byteLength(body), h: createHash('sha256').update(body).digest('hex'),
    })) });
    const checksumsSha256 = createHash('sha256').update(readFileSync(join(bundle, 'checksums.json'))).digest('hex');
    put(join(site, 'deployment-verification-attempt.json'), {
      schema: 'heimdall.deployment-verification-attempt/1', siteId: 'example.test', mode: 'static',
      generatedAt: '2026-11-15T02:00:00.000Z', status: 'failed', stage: 'browser-probe',
      bundle: 'deliverable/example.test-live-2026-11-15', bundleChecksumsSha256: checksumsSha256,
      error: { code: 'failed' }, browserProbe: {
        checked: 1, failed: 1, untested: 0, truncated: false, failureCount: 2,
        causes: 'externalRequest@analytics.ietf.org×1、http:404×1',
      },
    });
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.clone.delivery.deploymentVerificationAttempt.status, 'failed');
    assert.equal(result.clone.delivery.deploymentVerificationAttempt.browserProbe.causes, 'externalRequest@analytics.ietf.org×1、http:404×1');
    assert.equal(result.readiness.independentDeployment.status, 'needs_verification');
    assert.ok(result.deliveryPlan.items.some(item => item.id === 'independent-deployment' && item.status === 'blocked'));
    assert.ok(result.deliveryPlan.cloneTask.inputs.some(input => input.path.endsWith('/deployment-verification-attempt.json')));
    assert.equal(result.claims.verified.includes('clone.independent_deployment:network_none'), false);
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
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 1, issues: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      categories: {}, geo: {
        methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 100, confidence: 'high', actionPlan: [],
        coverage: { pages: 1, pagesScored: 1, pagesUnavailable: 0, observedWeight: 96, totalWeight: 96, ratio: 1 },
      },
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
      coverage: { pages: [{ path: '/', viewport: '1440x900' }], checks: [] },
      summary: { total: 1, fileable: 0, environment: 0, checkNeedsFix: 0, tolerable: 0, suppressed: 0 },
    });
    put(join(qa, '.heimdall', 'qa', 'runs', 'qa-20261111-130000-abcd', 'findings.json'), []);

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
    assert.equal(env.result.readiness.qa.nextAction.tool, 'heimdall_qa_metrics');
    assert.equal(env.result.deliveryPlan.seoGeoTask.scores.geoConfidence, 'high');
    assert.deepEqual(env.result.deliveryPlan.seoGeoTask.coverage.geo, {
      pages: 1, pagesScored: 1, pagesUnavailable: 0, observedWeight: 96, totalWeight: 96, ratio: 1, confidence: 'high',
    });
    assert.equal(env.result.deliveryPlan.seoGeoTask.outcomeEvidence.search.status, 'unknown');
    assert.equal(env.result.deliveryPlan.seoGeoTask.outcomeEvidence.modelCitation.status, 'unknown');
    assert.ok(env.result.deliveryPlan.seoGeoTask.tasks.some(item => item.id === 'measure-search-outcomes'));
    assert.ok(env.result.deliveryPlan.seoGeoTask.tasks.some(item => item.id === 'measure-model-citation-outcomes'));
    assert.ok(env.result.unknowns.some(item => item.id === 'seo-search-outcome-unknown'));
    assert.ok(env.result.unknowns.some(item => item.id === 'geo-model-citation-outcome-unknown'));
    assert.ok(env.result.deliveryPlan.items.some(item => item.id === 'api-contract' && item.status === 'open'));
    put(seoPath, { ...seoReport, scoreMethodVersion: SEO_SCORE_METHOD_VERSION - 1 });
    const staleRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(staleRun.status, 0, staleRun.stderr + staleRun.stdout);
    const stale = JSON.parse(staleRun.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(stale.seo.scoreMethodStatus, 'stale');
    assert.equal(stale.readiness.seo.status, 'needs_follow_up');
    assert.match(stale.deliveryPlan.items.find(item => item.id === 'seo-geo-follow-up').detail, /过时评分口径/);
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
      if (geo?.methodVersion !== GEO_METHOD_VERSION) {
        assert.equal(result.seo.geo.confidence, null);
        assert.equal(result.deliveryPlan.seoGeoTask.scores.geoConfidence, null);
        assert.equal(result.deliveryPlan.seoGeoTask.coverage.geo?.confidence ?? null, null);
      }
      assert.ok(result.deliveryPlan.items.some(item => item.id === 'seo-geo-follow-up'));
    }
    put(seoPath, { ...seoReport, summary: { ...seoReport.summary, sitemapCoverage: 'partial' }, geo: seoReport.geo });
    const partialSitemap = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--qa-workspace', qa, '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(partialSitemap.status, 0, partialSitemap.stderr + partialSitemap.stdout);
    const partialSitemapResult = JSON.parse(partialSitemap.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(partialSitemapResult.readiness.seo.status, 'needs_follow_up');
    assert.equal(partialSitemapResult.readiness.geo.status, 'needs_follow_up');
    assert.ok(partialSitemapResult.deliveryPlan.items.some(item => item.id === 'seo-geo-follow-up'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: accepts origin-bound external SEO/GEO outcome evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-outcome-evidence-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'seo', 'seo.json'), {
      origin: 'https://example.test', score: 100,
      scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION,
      summary: { pages: 1, issues: 0, bySeverity: {}, sitemapCoverage: 'complete', failedPages: 0, initialHtmlUnchecked: 0 },
      geo: { methodVersion: GEO_METHOD_VERSION, status: 'complete', score: 100, actionPlan: [],
        coverage: { pages: 1, pagesScored: 1, pagesUnavailable: 0, observedWeight: 96, totalWeight: 96, ratio: 1 } },
    });
    put(join(site, 'seo', 'outcome-evidence.json'), {
      schema: 'heimdall.seo-geo-outcome-evidence/1', origin: 'https://example.test', generatedAt: '2026-11-15T00:00:00.000Z',
      search: { status: 'observed', source: 'manual-search', samples: 10, hits: 4, indexedPages: 1, averagePosition: 3.5 },
      modelCitation: { status: 'observed', source: 'manual-model', samples: 8, hits: 3, sourceMentions: 5 },
    });
    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(result.seo.outcomeEvidence.sourceStatus, 'observed');
    assert.equal(result.seo.outcomeEvidence.search.hitRate, 0.4);
    assert.equal(result.deliveryPlan.seoGeoTask.outcomeEvidence.modelCitation.sourceMentions, 5);
    assert.equal(result.deliveryPlan.seoGeoTask.tasks.some(item => item.id === 'measure-search-outcomes'), false);
    assert.equal(result.deliveryPlan.seoGeoTask.tasks.some(item => item.id === 'measure-model-citation-outcomes'), false);
    assert.equal(result.unknowns.some(item => item.id === 'seo-search-outcome-unknown'), false);
    assert.equal(result.unknowns.some(item => item.id === 'geo-model-citation-outcome-unknown'), false);
    assert.equal(result.readiness.seo.status, 'ready');
    assert.equal(result.readiness.geo.status, 'ready');

    put(join(site, 'seo', 'outcome-evidence.json'), {
      schema: 'heimdall.seo-geo-outcome-evidence/1', origin: 'https://other.test', generatedAt: '2026-11-15T00:00:00.000Z',
      search: { status: 'observed', source: 'manual-search', samples: 10, hits: 4 },
      modelCitation: { status: 'observed', source: 'manual-model', samples: 8, hits: 3 },
    });
    const mismatch = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(mismatch.status, 0, mismatch.stderr + mismatch.stdout);
    const mismatchResult = JSON.parse(mismatch.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(mismatchResult.seo.outcomeEvidence.sourceStatus, 'origin_mismatch');
    assert.equal(mismatchResult.deliveryPlan.seoGeoTask.outcomeEvidence.search.status, 'unknown');
    assert.ok(mismatchResult.unknowns.some(item => item.id === 'seo-search-outcome-unknown'));
    assert.ok(mismatchResult.unknowns.some(item => item.id === 'geo-model-citation-outcome-unknown'));

    put(join(site, 'seo', 'outcome-evidence.json'), {
      schema: 'heimdall.seo-geo-outcome-evidence/1', origin: 'https://example.test', generatedAt: '2026-11-15T00:00:00.000Z',
      search: { status: 'observed', source: 'untrusted', samples: 10, hits: 4 },
      modelCitation: { status: 'observed', source: 'manual-model', samples: 8, hits: 3 },
    });
    const invalidSource = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(invalidSource.status, 0, invalidSource.stderr + invalidSource.stdout);
    const invalidSourceResult = JSON.parse(invalidSource.stdout.trim().split(/\r?\n/).at(-1)).result;
    assert.equal(invalidSourceResult.deliveryPlan.seoGeoTask.outcomeEvidence.search.status, 'unknown');
    assert.equal(invalidSourceResult.deliveryPlan.seoGeoTask.outcomeEvidence.modelCitation.status, 'observed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('site-assessment: clone AI task keeps capture, delivery, and deployment gates separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-site-assessment-clone-task-'));
  const site = join(root, 'workspace', 'example.test');
  try {
    put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><body>mirror</body>');
    put(join(site, 'pages', 'home', 'manifest.json'), { target: 'https://example.test/' });
    put(join(site, 'pages', 'about', 'manifest.json'), { target: 'https://example.test/about' });
    put(join(site, 'live-export.json'), {
      schema: 'heimdall.live-export/1', siteId: 'example.test', generatedAt: '2026-11-15T00:00:00.000Z',
      status: 'blocked', published: false, offline: true, strict: true, root: 'landing', pages: 1,
      blockingCount: 1, blockers: { unresolved: 1 }, browser: { checked: 1, failed: 0, untested: 0, totalPages: 1 },
      coverage: { scope: 'captured-only', scopeLimited: true }, note: 'private-value',
    });

    const run = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const { result } = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    const task = result.deliveryPlan.cloneTask;
    assert.equal(task.schema, 'heimdall.clone-ai-task/1');
    assert.equal(task.status, 'blocked_on_capture');
    assert.equal(task.scope.pages, 2);
    assert.equal(task.scope.mirrors, 1);
    assert.equal(task.scope.mirrorCoverage, 0.5);
    assert.equal(task.closure.schema, 'heimdall.rebuild-closure/1');
    assert.equal(task.closure.state, 'open');
    assert.deepEqual(task.closure.counts, { required: 5, verified: 0, open: 4, unknown: 1 });
    assert.deepEqual(task.closure.requiredObligations.map(item => item.id), [
      'mirror-coverage', 'visual-verification', 'strict-offline-delivery', 'delivery-scope', 'independent-deployment',
    ]);
    assert.equal(task.scope.visual.verificationGaps.total, 2);
    assert.deepEqual(task.scope.visual.verificationGaps.items, [
      { page: 'about', status: 'missing' }, { page: 'home', status: 'missing' },
    ]);
    assert.ok(task.observedActions.some(item => item.id === 'clone-mirror-coverage'));
    assert.ok(task.observedActions.some(item => item.id === 'clone-offline-delivery'));
    assert.ok(task.tasks.some(item => item.id === 'clone-mirror-coverage'));
    assert.match(task.tasks.find(item => item.id === 'clone-visual-verification').instruction, /about:missing/);
    assert.deepEqual(task.rebuild.workflow, ['study', 'build', 'check', 'refine', 'deliver']);
    assert.equal(task.rebuild.status, 'available');
    assert.equal(task.rebuild.page, 'home');
    assert.match(task.rebuild.commands[0], /rebuild init example\.test --page home/);
    assert.match(task.rebuild.commands[1], /compare --project <rebuild-dir> --page home --mode fast/);
    assert.equal(task.provenance.invented.length, 0);
    assert.match(task.prompt, /strict 导出/);
    assert.doesNotMatch(run.stdout, /private-value/);

    rmSync(join(site, 'pages', 'home', 'clone', 'index.html'));
    const noMirrorRun = spawnSync(process.execPath, [BIN, 'site-assessment', 'example.test', '--json'], {
      cwd: root, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(noMirrorRun.status, 0, noMirrorRun.stderr + noMirrorRun.stdout);
    const noMirrorTask = JSON.parse(noMirrorRun.stdout.trim().split(/\r?\n/).at(-1)).result.deliveryPlan.cloneTask;
    assert.equal(noMirrorTask.rebuild.status, 'blocked_on_capture');
    assert.deepEqual(noMirrorTask.rebuild.commands, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
