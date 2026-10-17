#!/usr/bin/env node
/** Fresh local Chromium collection followed by pure selected-side verification. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeAcceptanceBrowserSource } from './freeze-acceptance-browser-source.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';

const output = process.argv[2] ? resolve(process.argv[2])
  : fileURLToPath(new URL('../workspace/_runs/browser-source-smoke-' + randomUUID(), import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const checks = {};
await mkdir(output); // never overwrite a previous run, including its failed evidence
try {
  const index = await freezeAcceptanceBrowserSource(join(output, 'materials'));
  const sources = new Map();
  for (const sample of index.samples) {
    const dir = join(output, 'materials', sample.id);
    const files = new Map();
    for (const entry of sample.files) {
      const bytes = await readFile(join(dir, entry.file));
      assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
      files.set(entry.file, bytes);
    }
    const snapshot = { manifest: JSON.parse(files.get('manifest.json')), report: JSON.parse(files.get('report.json')),
      integrity: JSON.parse(await readFile(join(dir, 'integrity.json'))) };
    sources.set(sample.id, { snapshot, files });
  }
  checks.freshFourRunsWithExactBytes = sources.size === 4;
  const before = [...sources].map(([id, source]) => [id, sha(json(source.snapshot)),
    [...source.files].map(([file, bytes]) => [file, sha(bytes)])]);
  let fetchAttempts = 0;
  const originalFetch = globalThis.fetch;
  const results = new Map();
  try {
    // The fixture has already closed. Projection consumes captured bytes only.
    globalThis.fetch = () => { fetchAttempts++; throw new Error('Projection attempted network I/O'); };
    for (const [id, source] of sources) for (const side of ['baseline', 'target']) {
      const eligible = id === 'matrix' || id === 'target-unavailable' && side === 'baseline'
        || id === 'baseline-unavailable' && side === 'target';
      if (eligible) {
        const result = projectBrowserBaselineCandidate(source, { sourceSide: side });
        assert.deepEqual(result, projectBrowserBaselineCandidate(source, { sourceSide: side }));
        results.set(id + '/' + side, result);
      } else assert.throws(() => projectBrowserBaselineCandidate(source, { sourceSide: side }),
        error => error.details?.reason === 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE');
    }
  } finally { globalThis.fetch = originalFetch; }
  const baseline = results.get('matrix/baseline'), target = results.get('matrix/target');
  checks.failedComparisonStillAllowsBothHealthySides = baseline.preview.sourceGate === 'failed'
    && target.preview.sourceGate === 'failed' && baseline.preview.declaredSlots === 28 && target.preview.declaredSlots === 28;
  checks.targetOracleComesFromTarget = baseline.projection.oracleManifestKey !== target.projection.oracleManifestKey
    && target.preview.observations.every(observation => /-target\.png$/.test(observation.evidence.screenshot.file));
  checks.oppositeNullScreenshotsDoNotDisqualifyHealthySide = results.get('target-unavailable/baseline').preview.projectedSlots === 6
    && results.get('baseline-unavailable/target').preview.projectedSlots === 6;
  checks.failedSelectedSidesRejected = results.size === 4; // unavailable sides and both false assertions rejected above
  checks.completeReviewAndNoExecution = [...results.values()].every(result => result.preview.executionReady === false
    && !Object.hasOwn(result, 'plan') && result.preview.rules.length === result.preview.declaredSlots);
  checks.inputsUnchanged = json(before) === json([...sources].map(([id, source]) => [id, sha(json(source.snapshot)),
    [...source.files].map(([file, bytes]) => [file, sha(bytes)])]));
  checks.projectionIssuesZeroFetchRequests = fetchAttempts === 0;
  assert.ok(Object.values(checks).every(Boolean), json(checks));
  const summary = { schemaVersion: 1, status: 'passed', evidenceLevel: 'local-fixture-real-browser-and-offline-projection',
    checkCount: Object.keys(checks).length, checks, realBrowserRuns: index.samples.length, projectionCases: 8,
    eligibleProjections: results.size, rejectedProjections: 4, deterministicRechecks: results.size, projectionFetchAttempts: fetchAttempts,
    materialFiles: index.samples.reduce((sum, sample) => sum + sample.files.length, 0),
    cases: index.samples.map(({ id, runId, gate, declaredChecks, verifierFingerprint, reportSha256 }) => ({ id, runId, gate, declaredChecks, verifierFingerprint, reportSha256 })),
    boundary: 'No catalog ownership, release binding, approval, managed execution, external deployment or UI claim.' };
  await writeFile(join(output, 'summary.json'), json(summary), { flag: 'wx' });
  await writeFile(join(output, 'target-preview.json'), json(target), { flag: 'wx' });
  console.log(json(summary));
  console.log('Browser source smoke evidence: ' + output);
} catch (error) {
  await writeFile(join(output, 'failure.json'), json({ message: error.message, stack: error.stack, checks }), { flag: 'wx' });
  throw error;
}
