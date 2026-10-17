#!/usr/bin/env node
/** Fresh Chromium material -> owner-bound private reader -> pure explicit-side projection. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import childProcessDefault from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeAcceptanceBrowserSource } from './freeze-acceptance-browser-source.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { readBrowserCandidateSource } from '../src/acceptance/browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2])
  : fileURLToPath(new URL('../workspace/_runs/browser-reading-smoke-' + randomUUID(), import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const checks = {};
const events = [];
let owner;

function tree(root) {
  const files = [];
  const visit = path => {
    const stat = fs.lstatSync(path, { bigint: true });
    const item = { file: relative(root, path).replaceAll('\\', '/'),
      dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), nlink: String(stat.nlink) };
    if (stat.isDirectory()) {
      files.push({ ...item, kind: 'directory' });
      for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
    } else {
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      files.push({ ...item, kind: 'file', size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), sha256: sha(fs.readFileSync(path)) });
    }
  };
  visit(root);
  return files;
}

fs.mkdirSync(output); // New output only; failure evidence is never overwritten.
try {
  const index = await freezeAcceptanceBrowserSource(join(output, 'materials'));
  const root = resolve(repo, index.runtime);
  checks.fourFreshBrowserRuns = index.samples.length === 4;
  owner = acquireAcceptanceOwner({ root });
  const before = tree(root);
  const originals = [];
  const patch = (object, name) => {
    const original = object[name];
    originals.push([object, name, original]);
    object[name] = () => { events.push(name); throw new Error('Private reader attempted forbidden I/O'); };
  };
  const fetch = globalThis.fetch;
  let materialFiles = 0;
  let successfulReaderCaptures = 0, rejectedOwnerAttempts = 0, eligibilityCases = 0, rejectedProjections = 0;
  const projections = new Map();
  let targetPreview;
  try {
    // Collection and owner acquisition are complete. Observe only reader/projector work.
    for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync',
      'rmdirSync', 'truncateSync', 'ftruncateSync', 'writeSync', 'linkSync', 'symlinkSync', 'copyFileSync']) patch(fsDefault, name);
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(childProcessDefault, name);
    globalThis.fetch = () => { events.push('fetch'); throw new Error('Private source reading attempted a request'); };
    syncBuiltinESMExports();
    const matrix = index.samples.find(sample => sample.id === 'matrix');
    assert.throws(() => readBrowserCandidateSource(matrix.runId, { root,
      owner: Object.freeze({ root: owner.root, assertOwned: () => true }) }), error => error.status === 503);
    rejectedOwnerAttempts++;
    checks.requiresAcquiredOwnerBrand = true;
    for (const sample of index.samples) {
      const material = readBrowserCandidateSource(sample.runId, { root, owner });
      successfulReaderCaptures++;
      assert.deepEqual(Object.keys(material).sort(), ['files', 'snapshot']);
      assert.deepEqual([...material.files.keys()].sort(), sample.files.map(file => file.file).sort());
      for (const entry of sample.files) {
        const bytes = material.files.get(entry.file);
        assert.ok(Buffer.isBuffer(bytes));
        assert.equal(bytes.length, entry.bytes);
        assert.equal(sha(bytes), entry.sha256);
        materialFiles++;
      }
      const expectedIntegrity = JSON.parse(fs.readFileSync(join(output, 'materials', sample.id, 'integrity.json')));
      assert.deepEqual(material.snapshot.integrity, expectedIntegrity);
      for (const sourceSide of ['baseline', 'target']) {
        eligibilityCases++;
        const eligible = sample.id === 'matrix' || sample.id === 'target-unavailable' && sourceSide === 'baseline'
          || sample.id === 'baseline-unavailable' && sourceSide === 'target';
        if (eligible) {
          const result = projectBrowserBaselineCandidate(material, { sourceSide });
          assert.equal(result.preview.executionReady, false);
          assert.equal(result.preview.sourceGate, sample.gate);
          assert.deepEqual(Object.keys(result).sort(), ['preview', 'projection']);
          assert.ok(result.preview.observations.length > 0);
          for (const observation of result.preview.observations) {
            assert.ok(observation.evidence.details.file.endsWith('-' + sourceSide + '.json'));
            assert.ok(observation.evidence.screenshot.file.endsWith('-' + sourceSide + '.png'));
            assert.ok(observation.evidence.repeat.file.endsWith('-' + sourceSide + '-repeat.png'));
            for (const evidence of Object.values(observation.evidence)) {
              const raw = material.files.get(evidence.file);
              assert.equal(evidence.bytes, raw.length); assert.equal(evidence.sha256, sha(raw));
            }
            const details = JSON.parse(material.files.get(observation.evidence.details.file));
            assert.equal(observation.expected.httpStatus, details.httpStatus);
            assert.deepEqual(observation.expected.structure, { title: details.snapshot.title,
              headings: details.snapshot.headings, controls: details.snapshot.controls });
            assert.equal(observation.expected.screenshotSha256, sha(material.files.get(observation.evidence.screenshot.file)));
            if (observation.slot.pointId) assert.deepEqual(observation.expected.observedAssertions, details.assertions);
          }
          projections.set(sample.id + '/' + sourceSide, result);
          if (sample.id === 'matrix' && sourceSide === 'target') targetPreview = result;
        } else {
          assert.throws(() => projectBrowserBaselineCandidate(material, { sourceSide }),
            error => error.details?.reason === 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE');
          rejectedProjections++;
        }
      }
      material.files.get('manifest.json').fill(0);
      material.snapshot.manifest.runId = 'caller-mutation';
      const reread = readBrowserCandidateSource(sample.runId, { root, owner });
      successfulReaderCaptures++;
      assert.equal(reread.snapshot.manifest.runId, sample.runId);
      assert.equal(sha(reread.files.get('manifest.json')), sample.files.find(file => file.file === 'manifest.json').sha256);
    }
    checks.allOriginalBytesCaptured = materialFiles === index.samples.reduce((sum, sample) => sum + sample.files.length, 0);
    checks.integrityRebuiltFromActualReferences = true;
    checks.nullableBothDirectionsCaptured = projections.has('target-unavailable/baseline') && projections.has('baseline-unavailable/target');
    checks.explicitSideEightCases = eligibilityCases === 8 && projections.size === 4 && rejectedProjections === 4;
    checks.targetOracleRebuilt = projections.get('matrix/baseline').projection.oracleManifestKey
      !== projections.get('matrix/target').projection.oracleManifestKey;
    checks.failedComparisonPreserved = projections.get('matrix/baseline').preview.sourceGate === 'failed'
      && projections.get('matrix/target').preview.sourceGate === 'failed';
    checks.privateMaterialAndNoExecution = true;
    checks.callerMutationIsolated = true;
    checks.zeroReaderWritesRequestsOrLaunches = events.length === 0;
  } finally {
    for (const [object, name, original] of originals) object[name] = original;
    globalThis.fetch = fetch;
    syncBuiltinESMExports();
  }
  assert.deepEqual(tree(root), before);
  checks.originalFilesAndMetadataUnchanged = true;
  owner.release();
  const matrix = index.samples.find(sample => sample.id === 'matrix');
  assert.throws(() => readBrowserCandidateSource(matrix.runId, { root, owner }), error => error.status === 503);
  rejectedOwnerAttempts++;
  checks.releasedOwnerRejected = true;
  assert.ok(Object.values(checks).every(Boolean), json(checks));
  const summary = { schemaVersion: 1, status: 'passed', evidenceLevel: 'fresh-local-browser-owner-reader-and-pure-projection',
    checkCount: Object.keys(checks).length, checks, realBrowserRuns: index.samples.length, materialFiles,
    successfulReaderCaptures, rejectedOwnerAttempts, eligibilityCases,
    eligibleProjections: projections.size, rejectedProjections,
    forbiddenReaderEvents: events, sourceRunIds: index.samples.map(({ id, runId }) => ({ id, runId })),
    boundary: 'Private bounded read, no release binding, catalog approval, HTTP/UI or managed Browser execution; no atomic or future filesystem guarantee.' };
  fs.writeFileSync(join(output, 'summary.json'), json(summary), { flag: 'wx' });
  fs.writeFileSync(join(output, 'target-preview.json'), json(targetPreview), { flag: 'wx' });
  console.log(json(summary));
  console.log('Browser private reading evidence: ' + output);
} catch (error) {
  fs.writeFileSync(join(output, 'failure.json'), json({ message: error.message, stack: error.stack, checks, events }), { flag: 'wx' });
  throw error;
} finally { owner?.release(); }
