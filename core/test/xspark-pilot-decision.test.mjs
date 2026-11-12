import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decideDetectorExpansion, matchesFrozenBatch } from '../scripts/xspark-pilot-decision.mjs';

const verified = { true: 1, false: 0, unknown: 0 };
const complete = { runCount: 1, verified, measurementComplete: verified, failureKinds: {} };
const labels = { truePositive: 18, falsePositive: 2, unknown: 0 };
const missed = projectId => ({ family: 'generic-accessible-name', projectId, expected: true, detected: false });
const cases = [missed('one'), missed('two'), missed('three')];
const decide = (options = {}) => decideDetectorExpansion({ labels, oracle: { cases }, evidence: complete, ...options });

test('existing sanitized Xspark evidence remains blocked without rewriting the historical batch', async () => {
  const report = JSON.parse(await readFile(new URL('../../docs/audits/2026-11-05/xspark-pilot-metrics.json', import.meta.url)));
  const result = decideDetectorExpansion({ labels: report.labels, oracle: report.oracle, evidence: report.supplementalEvidence });
  assert.equal(result.schema, 'xspark.detector-decision/2');
  assert.equal(result.primaryAction, 'collect-more-evidence');
  assert.equal(result.detectorExpansion, 'blocked');
  assert.deepEqual(result.metrics, {
    ...report.decision.metrics,
    targeted: { cases: 2, falseNegative: 2 },
  });
  assert.equal(result.metrics.falseDiscoveryRate, 53.52);
  assert.deepEqual(result.secondaryActions, ['add-business-check', 'fix-existing-detectors']);
});

test('historical batch identity rejects missing, extra, substituted or duplicate runs', async () => {
  const report = JSON.parse(await readFile(new URL('../../docs/audits/2026-11-05/xspark-pilot-metrics.json', import.meta.url)));
  const frozen = report.runs;
  assert.equal(matchesFrozenBatch([...frozen].reverse(), frozen), true);
  assert.equal(matchesFrozenBatch(frozen.slice(1), frozen), false);
  assert.equal(matchesFrozenBatch([...frozen, frozen[0]], frozen), false);
  assert.equal(matchesFrozenBatch([{ ...frozen[0], runId: 'substituted' }, ...frozen.slice(1)], frozen), false);
  assert.equal(matchesFrozenBatch([frozen[1], ...frozen.slice(1)], frozen), false);
  assert.equal(matchesFrozenBatch([{ ...frozen[0], site: '' }, ...frozen.slice(1)], frozen), false);
});

test('missing, incomplete, unknown or inconsistent supplemental evidence blocks expansion', () => {
  for (const evidence of [
    undefined, {}, { ...complete, runCount: 0 }, { ...complete, complete: false }, { ...complete, complete: 'yes' },
    { ...complete, verified: undefined },
    { ...complete, verified: { true: 0, false: 1, unknown: 0 } },
    { ...complete, verified: { true: 0, false: 0, unknown: 1 } },
    { ...complete, measurementComplete: { true: 0, false: 1, unknown: 0 } },
    { ...complete, measurementComplete: { true: 0, false: 0, unknown: 1 } },
    { ...complete, measurementComplete: { true: 1, false: 0 } },
    { ...complete, measurementComplete: { true: 2, false: 0, unknown: 0 } },
    { ...complete, failureKinds: undefined }, { ...complete, failureKinds: [] },
    { ...complete, failureKinds: { network: 1 } },
    { ...complete, failureKinds: { 'network:unclassified': 1 } },
    { ...complete, failureKinds: { 'network:unknown': 1 } },
    { ...complete, failureKinds: { 'network:environment': -1 } },
    { ...complete, failureKinds: { 'network:environment': '1' } },
  ]) assert.equal(decide({ evidence }).detectorExpansion, 'blocked');
  assert.equal(decide({ evidence: { ...complete, failureKinds: { 'network:environment': 1, 'network:unclassified': 0 } } }).detectorExpansion, 'consider');
});

test('unknown or malformed labels and oracle cases cannot justify expansion', () => {
  for (const incomplete of [undefined, {}, { ...labels, unknown: 1 }, { ...labels, truePositive: -1 },
    { ...labels, truePositive: Number.MAX_SAFE_INTEGER, falsePositive: 1 }]) {
    assert.equal(decide({ labels: incomplete }).detectorExpansion, 'blocked');
  }
  for (const oracle of [undefined, {}, { cases: [] }, { cases: [null] },
    { cases: [{ ...cases[0], detected: null }] }, { cases: [{ ...cases[0], family: 'unknown' }] }]) {
    assert.equal(decide({ oracle }).detectorExpansion, 'blocked');
  }
});

test('incomplete inputs do not produce secondary recommendations from incomplete measurements', () => {
  const result = decide({ labels: { ...labels, unknown: 1, truePositive: 8, falsePositive: 12 },
    oracle: { cases: [{ family: 'business-display-rule', expected: true, detected: false }, null] } });
  assert.equal(result.detectorExpansion, 'blocked');
  assert.deepEqual(result.secondaryActions, []);
});

test('repeated runs and missing project identifiers do not count as independent projects', () => {
  for (const sameProject of [
    [missed('one'), missed('one'), missed('one')],
    [missed('One'), missed(' one '), missed('one')],
    [missed(), missed(), missed()],
    [missed('one'), missed('two'), { ...missed('three'), detected: true }],
  ]) {
    const result = decide({ oracle: { cases: sameProject } });
    assert.equal(result.detectorExpansion, 'do-not-add');
    assert.ok(result.secondaryActions.includes('collect-generic-samples'));
  }
  assert.equal(decide().detectorExpansion, 'consider');
  assert.equal(decide().confidence, 'low');
});

test('high false discovery takes priority over considering new detectors', () => {
  const result = decide({ labels: { truePositive: 15, falsePositive: 5, unknown: 0,
    falseDiscoveryRate: { numerator: 0, denominator: 20, percent: 0 } } });
  assert.equal(result.primaryAction, 'fix-existing-detectors');
  assert.equal(result.detectorExpansion, 'do-not-add');
  assert.equal(result.metrics.falseDiscoveryRate, 25);
});

test('an empty or too small reviewed alarm sample cannot justify expansion', () => {
  for (const counts of [
    { truePositive: 0, falsePositive: 0, unknown: 0 },
    { truePositive: 9, falsePositive: 0, unknown: 0 },
  ]) {
    const result = decide({ labels: counts });
    assert.equal(result.primaryAction, 'collect-more-evidence');
    assert.equal(result.detectorExpansion, 'blocked');
  }
  assert.equal(decide({ labels: { truePositive: 10, falsePositive: 0, unknown: 0 } }).detectorExpansion, 'consider');
});

test('business misses lead to a business check while preserving the noise warning', () => {
  const result = decide({ labels: { truePositive: 8, falsePositive: 12, unknown: 0 },
    oracle: { cases: [{ family: 'business-display-rule', expected: true, detected: false }] } });
  assert.equal(result.primaryAction, 'add-business-check');
  assert.equal(result.detectorExpansion, 'do-not-add');
  assert.deepEqual(result.secondaryActions, ['fix-existing-detectors']);
});
