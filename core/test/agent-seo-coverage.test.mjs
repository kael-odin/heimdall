import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-agent-seo-'));
process.env.HEIMDALL_DATA_DIR = root;
test.after(() => rmSync(root, { recursive: true, force: true }));

test('SEO agent reports incomplete coverage without linking a stale diff', async () => {
  const { default: capability } = await import('../src/agent/registry/capabilities/seo-audit.mjs');
  const directory = join(root, 'workspace', 'example.test', 'seo');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'seo.json'), JSON.stringify({
    origin: 'https://example.test', score: 100, summary: { initialHtmlUnchecked: 1 }, categories: {},
  }));
  writeFileSync(join(directory, 'diff.md'), 'old comparison');
  const jobs = {
    TERMINAL: new Set(['succeeded']),
    create: ({ finish }) => ({ job: { jobId: 'job_coverage', status: 'succeeded', result: finish() } }),
  };
  const response = await capability.handler({ url: 'https://example.test/', maxPages: 1, waitMs: 0 }, { jobs });
  assert.equal(response.ok, true);
  assert.match(response.summary, /部分完成.*1 页未核对初始 HTML/);
  assert.equal(response.result.result.summary.initialHtmlUnchecked, 1);
  assert.equal(response.result.result.reports.diff, null);
  writeFileSync(join(directory, 'seo.json'), JSON.stringify({
    origin: 'https://example.test', score: 100,
    summary: { initialHtmlUnchecked: 0, sitemapCoverage: 'partial', baselineEligible: false }, categories: {},
  }));
  const partial = await capability.handler({ url: 'https://example.test/', maxPages: 1, waitMs: 0 }, { jobs });
  assert.match(partial.summary, /sitemap 采集不完整/);
  assert.equal(partial.result.result.reports.diff, null);
  assert.equal(partial.result.result.grade, null);
  writeFileSync(join(directory, 'seo.json'), JSON.stringify({
    origin: 'https://example.test', score: 100,
    summary: { sitemapCoverage: 'complete', baselineEligible: true, baselineCompared: false }, categories: {},
  }));
  const firstRun = await capability.handler({ url: 'https://example.test/', maxPages: 1, waitMs: 0 }, { jobs });
  assert.equal(firstRun.result.result.reports.diff, null, 'first run must not link a stale diff');
  writeFileSync(join(directory, 'seo.json'), JSON.stringify({
    origin: 'https://example.test', score: 100, scoreMethodVersion: 2, measurementVersion: 2,
    summary: { sitemapCoverage: 'complete', baselineEligible: true, baselineCompared: false, baselineMethodMismatch: true }, categories: {},
  }));
  const mismatch = await capability.handler({ url: 'https://example.test/', maxPages: 1, waitMs: 0 }, { jobs });
  assert.match(mismatch.summary, /评分或测量口径不兼容/);
  assert.equal(mismatch.result.result.scoreMethodVersion, 2);
  assert.equal(mismatch.result.result.measurementVersion, 2);
  assert.equal(mismatch.result.result.reports.diff, null);
});

test('SEO matrix agent explains incomparable methods and hides legacy scores', async () => {
  const { default: capability } = await import('../src/agent/registry/capabilities/seo-matrix.mjs');
  const directory = join(root, 'workspace', '_matrix', 'incompatible-test');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'matrix.json'), JSON.stringify({
    generatedAt: '2026-11-09T00:00:00Z', sites: [
      { host: 'https://one.test', aggregate: { score: 90, issuesPerPage: 2, jsonldRate: 10 } },
      { host: 'https://two.test', aggregate: { score: 80, issuesPerPage: 3, jsonldRate: 20 } },
    ],
  }));
  const jobs = { TERMINAL: new Set(['succeeded']), create: ({ finish }) => ({ job: { jobId: 'matrix_coverage', status: 'succeeded', result: finish() } }) };
  const response = await capability.handler({ sites: ['https://one.test', 'https://two.test'], maxPages: 1, waitMs: 0 }, { jobs });
  assert.match(response.summary, /评分口径不兼容或未记录/);
  assert.equal(response.result.result.scoreComparison.comparable, false);
  assert.deepEqual(response.result.result.aggregates.map(a => a.score), [null, null]);
  assert.deepEqual(response.result.result.aggregates.map(a => a.issuesPerPage), [null, null]);
  assert.deepEqual(response.result.result.aggregates.map(a => a.jsonldRate), [null, null]);
  const matrix = JSON.parse(readFileSync(join(directory, 'matrix.json'), 'utf8'));
  matrix.scoreComparison = { comparable: false, methodVersion: null, reason: 'insufficient-eligible-audits' };
  writeFileSync(join(directory, 'matrix.json'), JSON.stringify(matrix));
  const incomplete = await capability.handler({ sites: ['https://one.test', 'https://two.test'], maxPages: 1, waitMs: 0 }, { jobs });
  assert.match(incomplete.summary, /完整审计不足两份/);
  matrix.scoreComparison = { comparable: true, methodVersion: 2, reason: null };
  matrix.jsonldComparison = { comparable: false, measurementVersion: null, reason: 'method-mismatch' };
  writeFileSync(join(directory, 'matrix.json'), JSON.stringify(matrix));
  const mixed = await capability.handler({ sites: ['https://one.test', 'https://two.test'], maxPages: 1, waitMs: 0 }, { jobs });
  assert.match(mixed.summary, /JSON-LD 测量口径不兼容/);
  assert.deepEqual(mixed.result.result.aggregates.map(a => a.score), [90, 80]);
  assert.deepEqual(mixed.result.result.aggregates.map(a => a.jsonldRate), [null, null]);
  assert.deepEqual(mixed.result.result.aggregates.map(a => a.issuesPerPage), [null, null]);
});
