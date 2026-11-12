import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeQaMetrics } from '../src/qa/metrics.mjs';
import { invoke } from '../src/agent/registry/invoke.mjs';

async function xspark() {
  return JSON.parse(await readFile(new URL('../../docs/audits/2026-11-05/xspark-pilot-metrics.json', import.meta.url)));
}

test('qa metrics recomputes the sanitized Xspark pilot without trusting stored percentages', async () => {
  const result = analyzeQaMetrics(await xspark());
  assert.deepEqual(result.coverage, {
    runs: 20, sites: 5, cohorts: 2, pageViewportChecks: 184, viewports: [390, 1440],
  });
  assert.equal(result.alarms.reviewed, 71);
  assert.equal(result.alarms.falseDiscoveryRate.percent, 53.52);
  assert.equal(result.alarms.falsePositiveRate.percent, null);
  assert.match(result.alarms.falsePositiveRate.reason, /经典 FPR/);
  assert.equal(result.oracle.falseNegativeRate.percent, 50);
  assert.deepEqual(result.oracle.byFamily.map(item => ({ family: item.family, cases: item.cases, falseNegative: item.falseNegative })), [
    { family: 'business-display-rule', cases: 2, falseNegative: 2 },
    { family: 'generic-accessible-name', cases: 2, falseNegative: 0 },
  ]);
  assert.equal(result.runtime.p50Ms, 46717);
  assert.equal(result.runtime.p95Ms, 73313);
  assert.deepEqual(result.failures.byKind, { 'console:observed': 4, 'network:environment': 13 });
  assert.equal(result.decision.primaryAction, 'collect-more-evidence');
  assert.equal(result.decision.detectorExpansion, 'blocked');
  assert.deepEqual(result.decision.secondaryActions, ['add-business-check', 'fix-existing-detectors']);
});

test('qa metrics calculates classic FPR only when normal cases are exhaustive', () => {
  const result = analyzeQaMetrics({
    labels: { truePositive: 1, falsePositive: 2, unknown: 0, trueNegative: 8, normalExhaustive: true },
    oracle: { cases: [
      { family: 'generic-accessible-name', expected: true, detected: true },
      { family: 'generic-accessible-name', expected: false, detected: true },
    ] },
    supplementalEvidence: {
      complete: true, runCount: 1,
      verified: { true: 1, false: 0, unknown: 0 },
      measurementComplete: { true: 1, false: 0, unknown: 0 },
      failureKinds: {},
    },
    runs: [{ runId: 'r1', elapsedMs: 1000 }],
  });
  assert.equal(result.alarms.falseDiscoveryRate.percent, 66.67);
  assert.equal(result.alarms.falsePositiveRate.percent, 20);
  assert.equal(result.oracle.falsePositiveRate.percent, 100);
});

test('qa metrics accepts named domain oracles beyond the Xspark families', () => {
  const result = analyzeQaMetrics({
    labels: { truePositive: 1, falsePositive: 0, unknown: 0 },
    oracle: { cases: [
      { family: 'api-response-contract', expected: true, detected: false },
    ] },
    supplementalEvidence: {
      complete: true, runCount: 1,
      verified: { true: 1, false: 0, unknown: 0 },
      measurementComplete: { true: 1, false: 0, unknown: 0 },
      failureKinds: {},
    },
    runs: [{ runId: 'r1', elapsedMs: 1000 }],
  });
  assert.equal(result.oracle.status, 'complete');
  assert.equal(result.oracle.falseNegativeRate.percent, 100);
  assert.deepEqual(result.oracle.byFamily.map(item => ({ family: item.family, cases: item.cases, falseNegative: item.falseNegative })), [
    { family: 'api-response-contract', cases: 1, falseNegative: 1 },
  ]);
  assert.equal(result.decision.primaryAction, 'add-business-check');
  assert.equal(result.decision.detectorExpansion, 'do-not-add');
  assert.deepEqual(result.decision.metrics.targeted, { cases: 1, falseNegative: 1 });
});

test('QA run summaries expose runtime and failure classes but keep expansion blocked without labels and oracle', () => {
  const result = analyzeQaMetrics({ runs: [
    { runId: 'r1', site: 'web', elapsedMs: 1000, pageViews: 2, coverage: { pages: [], detection: { failedPages: [] } } },
    { runId: 'r2', site: 'web', elapsedMs: 3000, pageViews: 2, coverage: { pages: [{ navError: 'timeout' }], detection: { failedPages: [] } } },
  ] });
  assert.equal(result.runtime.p50Ms, 2000);
  assert.equal(result.runtime.p95Ms, 2900);
  assert.equal(result.coverage.pageViewportChecks, 4);
  assert.deepEqual(result.failures.byKind, { navigation: 1 });
  assert.equal(result.decision.detectorExpansion, 'blocked');
});

test('invalid failure classifications are visible and block a detector decision', () => {
  const result = analyzeQaMetrics({
    labels: { truePositive: 10, falsePositive: 0, unknown: 0 },
    failureKinds: { network: 'unknown' },
    oracle: { cases: [{ family: 'generic-accessible-name', expected: true, detected: true }] },
    runs: [{ runId: 'r1', elapsedMs: 1000 }],
  });
  assert.equal(result.failures.invalidEntries, 1);
  assert.deepEqual(result.failures.unclassified, ['invalid-input']);
  assert.equal(result.decision.detectorExpansion, 'blocked');
});

test('MCP/HTTP shared invocation returns the same aggregate result and no raw input', async () => {
  const data = await xspark();
  const env = await invoke('qa_metrics', { data }, { client: 'mcp' });
  assert.equal(env.ok, true);
  assert.equal(env.result.schema, 'heimdall.qa-metrics/1');
  assert.equal(env.result.alarms.falseDiscoveryRate.percent, 53.52);
  assert.equal(JSON.stringify(env).includes(data.measurementCommit), false);
});
