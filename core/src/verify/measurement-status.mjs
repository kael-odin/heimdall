import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { isSafePageName } from '../page-name.mjs';
import { canonUrl } from '../url-canon.mjs';
import { evidenceSha256, measurementIdentity, resultSha256 } from './resume-cache.mjs';
import { verifierSha256 } from './verifier-fingerprint.mjs';

export function invalidatedVerifications(baseDir) {
  const file = join(baseDir, 'verify', 'verify-summary.json');
  try {
    const summary = JSON.parse(readFileSync(file, 'utf8'));
    if (summary.mode !== 'all' || !Array.isArray(summary.pages)) return new Map();
    const stamp = Date.parse(summary.generatedAt ?? '');
    const at = Number.isFinite(stamp) ? stamp : statSync(file).mtimeMs;
    return new Map(summary.pages.filter(page => isSafePageName(page?.page) && (page.measured === false || page.invalidated))
      .map(page => [page.page, at]));
  } catch { return new Map(); }
}

export function createMeasurementReader(baseDir) {
  const invalidated = invalidatedVerifications(baseDir);
  let verifier;
  const currentVerifier = () => {
    if (verifier === undefined) {
      try { verifier = verifierSha256(); } catch { verifier = null; }
    }
    return verifier;
  };
  function read(page) {
    if (!isSafePageName(page)) return { status: 'invalid' };
    const pageDir = join(baseDir, 'pages', page);
    const outDir = join(baseDir, 'verify', page);
    let result;
    try { result = JSON.parse(readFileSync(join(outDir, 'verify.json'), 'utf8')); }
    catch { return { status: 'missing' }; }
    if (result?.scoreVersion !== 2) return { status: 'legacy' };
    if (result.measured !== true) return { status: 'incomplete' };
    try {
      const stamp = Date.parse(result.generatedAt ?? '');
      const proof = result.measurementProof;
      const options = proof?.options;
      const manifest = JSON.parse(readFileSync(join(pageDir, 'manifest.json'), 'utf8'));
      const target = canonUrl(manifest.target);
      if (!Number.isFinite(stamp) || stamp <= (invalidated.get(page) ?? -Infinity)
        || !target || canonUrl(result.target) !== target
        || !Number.isFinite(result.overall) || result.overall < 0 || result.overall > 1
        || !Array.isArray(result.viewports) || !result.viewports.length
        || proof?.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.inputs ?? '')
        || !/^[a-f0-9]{64}$/.test(proof.evidence ?? '') || !/^[a-f0-9]{64}$/.test(proof.resultSha256 ?? '')
        || resultSha256(result) !== proof.resultSha256 || typeof options?.keepScreenshots !== 'boolean'
        || typeof options.interactions !== 'boolean' || typeof options.allowBounded !== 'boolean'
        || !Number.isInteger(options.settleTimeout) || options.settleTimeout < 2500 || options.settleTimeout > 15000
        || !Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 8
        || !Array.isArray(options.viewports) || new Set(options.viewports).size !== options.viewports.length
        || JSON.stringify(options.viewports) !== JSON.stringify(result.viewports.map(viewport => viewport.name))
        || result.viewports.some(viewport => !Number.isFinite(viewport?.score) || viewport.score < 0 || viewport.score > 1
          || viewport.additionalVisibleBrokenImages !== 0
          || (viewport.settleTimedOut !== false && !(viewport.settleTimedOut === true
            && options.allowBounded && viewport.confidence === 'bounded')))
        || !result.minViewport || !result.viewports.some(viewport => viewport.name === result.minViewport.name
          && viewport.score === result.minViewport.score)
        || result.minViewport.score !== Math.min(...result.viewports.map(viewport => viewport.score))) {
        return { status: 'stale' };
      }
      const verifier = currentVerifier();
      if (!verifier || proof.verifier !== verifier
        || measurementIdentity(pageDir, options, verifier)?.inputs !== proof.inputs
        || evidenceSha256(result, outDir, options.keepScreenshots) !== proof.evidence) return { status: 'stale' };
      return { status: 'verified', result };
    } catch { return { status: 'stale' }; }
  }
  return { read, currentVerifier };
}

function scanMeasurements(baseDir, pages) {
  const reader = createMeasurementReader(baseDir);
  const viewport = v => ({ name: v.name, score: v.score, grade: v.grade ?? null,
    coverageRatio: v.coverageRatio ?? null, sourceSize: v.sourceSize ?? null, cloneSize: v.cloneSize ?? null,
    heightDelta: v.heightDelta ?? null, missingPixels: v.missingPixels ?? null });
  return pages.map(page => {
    const { status, result } = reader.read(page);
    return { page, status, ...(result?.measurementProof?.inputs ? { inputSha256: result.measurementProof.inputs } : {}), ...(result ? { result: { measured: true, generatedAt: result.generatedAt, overall: result.overall,
      scoreVersion: result.scoreVersion, grade: result.grade ?? null, minViewport: viewport(result.minViewport),
      viewports: result.viewports.map(viewport), functional: result.functional, confidence: result.confidence,
      interactions: Array.isArray(result.interactions) ? result.interactions.slice(0, 3).map(ix => ({
        label: ix?.label ?? null, pass: ix?.pass ?? null, visualScore: ix?.visualScore ?? null, unverified: ix?.unverified === true,
      })) : [] } } : {}) };
  });
}

export function summaryMatchesMeasurement(row, result) {
  return row?.measured === true && result?.measured === true
    && typeof row.measuredAt === 'string' && row.measuredAt === result.generatedAt
    && row.overall === result.overall && row.minViewport?.name === result.minViewport?.name
    && row.minViewport?.score === result.minViewport?.score;
}

export function measurementCoverage(scan, total) {
  if (scan.status !== 'ok') return { status: scan.status, verified: null, unmeasured: null, average: null };
  const measured = scan.pages.filter(row => row.status === 'verified');
  return { status: 'checked', verified: measured.length, unmeasured: total - measured.length,
    average: measured.length ? measured.reduce((sum, row) => sum + row.result.overall, 0) / measured.length : null };
}

let activeWorkers = 0;
export function scanMeasurementsAsync(baseDir, pages) {
  if (!pages.length) return Promise.resolve({ status: 'ok', pages: [] });
  if (activeWorkers >= 2) return Promise.resolve({ status: 'busy', pages: [] });
  activeWorkers++;
  return new Promise(resolve => {
    let worker;
    let finished = false;
    const finish = async value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
      if (worker) await worker.terminate().catch(() => {});
      activeWorkers--;
    };
    const timer = setTimeout(() => finish({ status: 'timeout', pages: [] }), 60_000);
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { kind: 'heimdall-measurement-status', baseDir, pages },
        execArgv: [],
      });
      worker.once('message', rows => finish({ status: 'ok', pages: rows }));
      worker.once('error', () => finish({ status: 'unavailable', pages: [] }));
      worker.once('exit', () => finish({ status: 'unavailable', pages: [] }));
    } catch { finish({ status: 'unavailable', pages: [] }); }
  });
}

if (!isMainThread && workerData?.kind === 'heimdall-measurement-status') {
  parentPort.postMessage(scanMeasurements(workerData.baseDir, workerData.pages));
}
