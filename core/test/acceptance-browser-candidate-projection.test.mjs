import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  BROWSER_CANDIDATE_PROJECTION_V1, BROWSER_CANDIDATE_LIMITS_V1, SUPPORTED_BROWSER_VERIFIERS_V1,
  projectBrowserBaselineCandidate, verifyBrowserBaselineMaterial,
} from '../src/acceptance/browser-candidate-projection.mjs';
import { AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';

const ROOT = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const references = report => [...new Set(report.checks.flatMap(check => Object.values(check.evidence ?? {}))
  .filter(file => file !== null))];
const cloneSource = source => ({ snapshot: copy(source.snapshot),
  files: new Map([...source.files].map(([file, data]) => [file, Buffer.from(data)])) });
const project = (source, sourceSide = 'baseline') => projectBrowserBaselineCandidate(source, { sourceSide });

/** Re-seal every transport hash after a deliberate semantic mutation. */
function seal(source) {
  const { manifest, report } = source.snapshot;
  const names = references(report);
  for (const entry of report.evidenceManifest) if (names.includes(entry.file) && source.files.has(entry.file)) {
    const data = source.files.get(entry.file); entry.bytes = data.length; entry.sha256 = sha(data);
  }
  const normalized = summarizeAcceptanceReport(report);
  report.summary = normalized.summary; report.gate = normalized.gate;
  manifest.summary = copy(report.summary); manifest.gate = report.gate;
  source.files.set('report.json', bytes(report));
  manifest.reportSha256 = sha(source.files.get('report.json'));
  source.files.set('manifest.json', bytes(manifest));
  const indexed = new Map(report.evidenceManifest.map(entry => [entry.file, entry]));
  source.snapshot.integrity = { valid: true, evidenceVerified: true, errors: [], verifiedFiles: names.length,
    verifiedBytes: names.reduce((sum, file) => sum + (indexed.get(file)?.bytes ?? 0), 0),
    reportSha256: manifest.reportSha256 };
  return source;
}

function rejects(source, reason, sourceSide = 'baseline') {
  assert.throws(() => project(source, sourceSide), error => error instanceof AcceptanceCatalogError
    && error.status === 409 && ['SOURCE_NOT_ELIGIBLE', 'SOURCE_INTEGRITY_FAILED'].includes(error.code)
    && (reason === undefined || (Array.isArray(reason) ? reason : [reason]).includes(error.details?.reason)),
  reason === undefined ? 'material must be rejected' : String(reason));
}

function editDetails(source, check, side, mutate) {
  const name = check.evidence[side + 'Details'];
  const detail = JSON.parse(source.files.get(name));
  mutate(detail);
  source.files.set(name, bytes(detail));
  return detail;
}

const checkOf = (source, facet, route, viewport) => source.snapshot.report.checks.find(check =>
  check.identity?.facet === facet && (route === undefined || new URL(check.route, 'http://source.invalid').pathname === route)
  && (viewport === undefined || check.viewport === viewport));

async function loadSource(id = 'matrix') {
  const dir = join(ROOT, id);
  const [manifest, report, integrity] = await Promise.all(['manifest.json', 'report.json', 'integrity.json']
    .map(async file => JSON.parse(await readFile(join(dir, file)))));
  const names = ['manifest.json', 'report.json', ...references(report)];
  const files = new Map(await Promise.all(names.map(async file => [file, await readFile(join(dir, file))])));
  return { snapshot: { manifest, report, integrity }, files };
}

function beforeSource(source) {
  return { snapshot: bytes(source.snapshot), files: [...source.files].map(([file, data]) => [file, sha(data)]) };
}

test('frozen real matrix independently verifies all original bytes and complete declared slots', async () => {
  const index = JSON.parse(await readFile(join(ROOT, 'source-index.json')));
  assert.equal(index.kind, 'frozen-real-browser-source-material');
  for (const sample of index.samples) {
    const actualNames = (await readdir(join(ROOT, sample.id))).filter(file => file !== 'integrity.json').sort();
    assert.deepEqual(actualNames, sample.files.map(entry => entry.file).sort());
    for (const entry of sample.files) {
      const data = await readFile(join(ROOT, sample.id, entry.file));
      assert.equal(data.length, entry.bytes, sample.id + '/' + entry.file);
      assert.equal(sha(data), entry.sha256, sample.id + '/' + entry.file);
    }
    const source = await loadSource(sample.id);
    assert.equal(source.snapshot.report.runId, sample.runId);
    assert.equal(sha(source.files.get('report.json')), sample.reportSha256);
    assert.equal(source.snapshot.integrity.verifiedFiles, references(source.snapshot.report).length);
    assert.equal(source.snapshot.integrity.verifiedBytes, references(source.snapshot.report)
      .reduce((sum, file) => sum + source.files.get(file).length, 0));
  }
  const source = await loadSource();
  const plan = source.snapshot.manifest.plan;
  assert.equal(plan.routes.length, 2); assert.equal(plan.viewports.length, 2); assert.equal(plan.points.length, 2);
  assert.notEqual(plan.points[0].route, plan.points[1].route);
  const declared = plan.routes.length * plan.viewports.length * 6 + plan.points.length * plan.viewports.length;
  assert.equal(declared, 28);
  const before = beforeSource(source);
  for (const side of ['baseline', 'target']) {
    const result = project(source, side);
    assert.deepEqual(result, project(source, side));
    assert.deepEqual(Object.keys(result).sort(), ['preview', 'projection']);
    assert.equal(result.preview.sourceGate, 'failed');
    assert.equal(result.preview.sourceStatus, 'completed');
    assert.equal(result.preview.executionReady, false);
    assert.equal(result.preview.declaredSlots, declared); assert.equal(result.preview.projectedSlots, declared);
    assert.equal(result.preview.rules.length, declared); assert.equal(result.preview.observations.length, 8);
    assert.deepEqual(result.preview.omissions, []);
    assert.equal(result.projection.source.side, side);
    assert.equal(result.projection.source.entryUrl, plan[side + 'Url']);
    assert.equal(result.projection.sourceReportDigest, source.snapshot.manifest.reportSha256);
    assert.equal(Object.hasOwn(result.projection, 'projectId'), false);
    assert.equal(Object.hasOwn(result.projection.source, 'releaseId'), false);
    assert.equal(Object.hasOwn(result, 'plan'), false);
    assert.equal(JSON.stringify(result).includes('"type":"Buffer"'), false);
    const verified = verifyBrowserBaselineMaterial(source, { sourceSide: side });
    assert.deepEqual(verified.plan, plan);
    assert.notEqual(verified.plan, plan);
    result.preview.observations[0].expected.structure.title = 'independent result object';
    assert.deepEqual(beforeSource(source), before);
  }
});

test('target approval oracle is rebuilt from target screenshots and details while original expected stays old-baseline', async () => {
  const source = await loadSource(), plan = source.snapshot.manifest.plan;
  const baseline = project(source, 'baseline'), target = project(source, 'target');
  assert.equal(baseline.projection.scopeKey, target.projection.scopeKey);
  assert.equal(baseline.projection.ruleManifestKey, target.projection.ruleManifestKey);
  assert.equal(baseline.projection.environmentKey, target.projection.environmentKey);
  assert.notEqual(baseline.projection.oracleManifestKey, target.projection.oracleManifestKey);
  assert.notEqual(baseline.projection.selectedEvidenceManifestDigest, target.projection.selectedEvidenceManifestDigest);
  assert.notEqual(baseline.projection.contentDigest, target.projection.contentDigest);
  for (const observation of target.preview.observations) {
    const detail = JSON.parse(source.files.get(observation.evidence.details.file));
    assert.match(observation.evidence.screenshot.file, /-target\.png$/);
    assert.match(observation.evidence.repeat.file, /-target-repeat\.png$/);
    assert.equal(observation.expected.screenshotSha256, sha(source.files.get(detail.screenshot)));
    assert.deepEqual(observation.expected.structure, { title: detail.snapshot.title,
      headings: detail.snapshot.headings, controls: detail.snapshot.controls });
    assert.equal(observation.expected.httpStatus, detail.httpStatus);
    assert.equal(observation.plannedUrl.startsWith(plan.targetUrl.split('?')[0]), true);
    if (observation.slot.pointId) {
      const point = plan.points.find(item => item.id === observation.slot.pointId);
      assert.deepEqual(observation.expected.steps, point.steps);
      assert.deepEqual(observation.expected.assertions, point.assertions);
      assert.deepEqual(observation.expected.observedAssertions, detail.assertions);
    }
  }
  const visual = checkOf(source, 'visual', '/visual-shift', 'desktop');
  const baseImage = sha(source.files.get(visual.evidence.baselineScreenshot));
  const targetImage = sha(source.files.get(visual.evidence.targetScreenshot));
  assert.notEqual(baseImage, targetImage, 'fixture must contain a real visually different healthy target');
  const targetObservation = target.preview.observations.find(item => new URL(item.slot.route, 'http://source.invalid').pathname === '/visual-shift'
    && item.viewportName === 'desktop' && !item.slot.pointId);
  assert.equal(targetObservation.expected.screenshotSha256, targetImage);
  assert.notEqual(targetObservation.expected.screenshotSha256, baseImage);
  assert.equal(visual.expected.minimumScore, plan.thresholds.visual);
  assert.equal(visual.oracle.source, plan.baselineUrl);
});

test('healthy chosen side remains usable when the opposite navigation has null screenshots', async () => {
  for (const [sample, eligible, unavailable] of [
    ['target-unavailable', 'baseline', 'target'], ['baseline-unavailable', 'target', 'baseline'],
  ]) {
    const source = await loadSource(sample), before = beforeSource(source);
    assert.equal(source.snapshot.report.gate, 'blocked');
    assert.ok(source.snapshot.report.checks.some(check => check.evidence[unavailable + 'Screenshot'] === null));
    assert.ok(source.snapshot.report.checks.some(check => check.evidence[unavailable + 'Repeat'] === null));
    const result = project(source, eligible);
    assert.equal(result.preview.declaredSlots, 6); assert.equal(result.preview.projectedSlots, 6);
    assert.equal(result.preview.sourceGate, 'blocked');
    assert.equal(result.preview.executionReady, false);
    assert.equal(result.projection.source.side, eligible);
    assert.equal(source.snapshot.integrity.verifiedFiles, 4);
    assert.equal(source.files.size, 6);
    rejects(source, 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE', unavailable);
    assert.deepEqual(beforeSource(source), before);
  }
});

test('real failed declared assertion disqualifies that side despite successful navigation and complete screenshot evidence', async () => {
  const source = await loadSource('assertion-failed');
  const check = checkOf(source, 'behavior');
  for (const side of ['baseline', 'target']) {
    const detail = JSON.parse(source.files.get(check.evidence[side + 'Details']));
    assert.equal(detail.httpStatus, 200); assert.equal(detail.navigationError, null);
    assert.ok(detail.screenshot); assert.ok(detail.repeatedScreenshot);
    assert.ok(detail.assertions.some(assertion => assertion.passed === false));
    rejects(source, 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE', side);
  }
});

test('transport files, source digest and every actual referenced evidence are independently checked', async () => {
  const source = await loadSource();
  const cases = [
    ['SOURCE_FILE_MISSING', changed => changed.files.delete('manifest.json')],
    ['SOURCE_FILE_MISSING', changed => changed.files.delete(checkOf(changed, 'visual').evidence.targetRepeat)],
    ['SOURCE_SNAPSHOT_BYTES_MISMATCH', changed => { const report = copy(changed.snapshot.report);
      report.name = 'altered raw bytes'; changed.files.set('report.json', bytes(report)); }],
    ['SOURCE_REPORT_DIGEST_MISMATCH', changed => { changed.snapshot.report.name = 'changed';
      changed.files.set('report.json', bytes(changed.snapshot.report)); }],
    ['SOURCE_EVIDENCE_DIGEST_MISMATCH', changed => changed.files.set(checkOf(changed, 'visual').evidence.targetScreenshot, Buffer.from('png'))],
    ['SOURCE_VERIFIED_INDEX_MISMATCH', changed => { changed.snapshot.integrity.verifiedBytes++; }],
    ['SOURCE_INTEGRITY_FAILED', changed => { changed.snapshot.integrity.evidenceVerified = false; }],
  ];
  for (const [reason, mutate] of cases) {
    const changed = cloneSource(source); mutate(changed); rejects(changed, reason);
  }
});

test('complete slots are derived from the normalized plan rather than trusted coverage or generic hashes', async () => {
  const source = await loadSource();
  const cases = [
    ['omitted check with fabricated complete coverage', changed => {
      changed.snapshot.report.checks.splice(2, 1);
      changed.snapshot.report.coverage.planned--; changed.snapshot.report.coverage.completed--;
    }],
    ['duplicate same slot and ID', changed => { changed.snapshot.report.checks.push(copy(changed.snapshot.report.checks[0])); }],
    ['duplicate slot under another ID', changed => { const row = copy(changed.snapshot.report.checks[0]);
      row.id += '-duplicate'; changed.snapshot.report.checks.push(row); }],
    ['borrow another route', changed => { checkOf(changed, 'console').route = '/identical'; }],
    ['borrow another viewport', changed => { checkOf(changed, 'network').viewport = 'mobile'; }],
    ['borrow another point', changed => { checkOf(changed, 'behavior').identity.pointId = changed.snapshot.manifest.plan.points[1].id; }],
    ['forge base facet', changed => { checkOf(changed, 'structure').identity.facet = 'visual'; }],
    ['capped coverage', changed => { changed.snapshot.report.coverage.capped = true; }],
    ['undeclared runner environment row', changed => { changed.snapshot.report.checks.push({
      ...copy(changed.snapshot.report.checks[0]), id: 'runner-environment' }); }],
  ];
  for (const [name, mutate] of cases) {
    const changed = cloneSource(source); mutate(changed); seal(changed);
    assert.equal(changed.snapshot.integrity.valid, true, name);
    rejects(changed);
  }
});

test('role substitution across screenshot, repeat, route, viewport, point and side is rejected after resealing', async () => {
  const source = await loadSource();
  const cases = [
    ['baselineScreenshot', other => other.targetScreenshot],
    ['baselineScreenshot', other => other.baselineRepeat],
    ['baselineDetails', other => other.targetDetails],
    ['targetRepeat', other => other.targetScreenshot],
  ];
  for (const [role, substitute] of cases) {
    const changed = cloneSource(source), row = checkOf(changed, 'visual');
    row.evidence[role] = substitute(row.evidence); seal(changed); rejects(changed);
  }
  for (const selector of [
    changed => checkOf(changed, 'visual', '/identical', 'desktop'),
    changed => checkOf(changed, 'visual', '/visual-shift', 'mobile'),
    changed => checkOf(changed, 'behavior', '/visual-shift', 'desktop'),
  ]) {
    const changed = cloneSource(source), row = checkOf(changed, 'visual', '/visual-shift', 'desktop');
    row.evidence = copy(selector(changed).evidence); seal(changed); rejects(changed);
  }
});

test('resealed details cannot invent successful steps, assertion outcomes or selected-side health', async () => {
  const source = await loadSource();
  const cases = [
    ['empty DOM', 'visual', detail => { detail.snapshot.bodyTextLength = 0; }],
    ['step failure', 'visual', detail => { detail.stepError = 'declared interaction did not complete'; }],
    ['script error', 'visual', detail => { detail.errors.push({ kind: 'pageerror', message: 'observed failure' }); }],
    ['network failure', 'visual', detail => { detail.network.push({ kind: 'http', status: 500, method: 'GET', url: detail.url }); }],
    ['read-only block', 'visual', detail => { detail.blockedRequests.push({ kind: 'write-blocked', method: 'POST', url: detail.url }); }],
    ['overflow', 'visual', detail => { detail.snapshot.overflow = true; }],
    ['empty assertion results', 'behavior', detail => { detail.assertions = []; }],
    ['invented passed flag', 'behavior', detail => { detail.assertions[0].actual = false; detail.assertions[0].passed = true; }],
    ['changed assertion expectation', 'behavior', detail => { detail.assertions[1].expected = 'false'; }],
    ['changed assertion selector', 'behavior', detail => { detail.assertions[0].selector = '#unrelated'; }],
    ['reordered assertions', 'behavior', detail => { detail.assertions.reverse(); }],
    ['capture incomplete', 'visual', detail => { detail.captureScope = 'viewport-only'; detail.snapshot.captureScope = 'viewport-only'; }],
    ['mask budget', 'visual', detail => { detail.snapshot.maskedRatio = 0.9;
      detail.snapshot.effectiveAreaPx = Math.round(960 * 640 * 0.1); }],
    ['mask sampling incomplete', 'visual', detail => { detail.snapshot.maskSamplingCapped = true; }],
  ];
  for (const [name, facet, mutate] of cases) {
    const changed = cloneSource(source), check = checkOf(changed, facet, '/visual-shift', 'desktop');
    editDetails(changed, check, 'target', mutate); seal(changed);
    assert.equal(changed.snapshot.integrity.valid, true, name);
    rejects(changed, undefined, 'target');
  }
});

test('PNG signatures, IHDR dimensions, cumulative pixels and encoded content are checked before trust', async () => {
  const source = await loadSource();
  const mutateImage = (mutate, reason) => {
    const changed = cloneSource(source), file = checkOf(changed, 'visual').evidence.targetScreenshot;
    const data = Buffer.from(changed.files.get(file)); mutate(data); changed.files.set(file, data); seal(changed);
    rejects(changed, reason, 'target');
  };
  mutateImage(data => { data[0] = 0; }, 'SOURCE_PNG_INVALID');
  mutateImage(data => { data.writeUInt32BE(0, 16); }, 'SOURCE_PNG_BUDGET');
  mutateImage(data => { data.writeUInt32BE(BROWSER_CANDIDATE_LIMITS_V1.pngDimension + 1, 20); }, 'SOURCE_PNG_BUDGET');
  mutateImage(data => { data.writeUInt32BE(4000, 16); data.writeUInt32BE(4000, 20); }, 'SOURCE_PNG_BUDGET');
  mutateImage(data => { data[data.length - 1] ^= 0xff; }, 'SOURCE_PNG_INVALID');

  const cumulative = cloneSource(source);
  for (const file of references(cumulative.snapshot.report).filter(file => file.endsWith('.png'))) {
    const data = Buffer.from(cumulative.files.get(file));
    // Each header is within the individual limit. The full set must fail the
    // global header preflight without attempting to decode this changed CRC.
    data.writeUInt32BE(1000, 16); data.writeUInt32BE(12000, 20);
    cumulative.files.set(file, data);
  }
  seal(cumulative); rejects(cumulative, 'SOURCE_PNG_TOTAL_BUDGET', 'target');
});

test('claimed stability is recomputed from the actual selected first/repeat pair', async () => {
  const source = await loadSource(), changed = cloneSource(source);
  const check = checkOf(changed, 'visual', '/visual-shift', 'desktop');
  const detail = JSON.parse(changed.files.get(check.evidence.targetDetails));
  assert.equal(detail.stability, 1);
  changed.files.set(check.evidence.targetRepeat, Buffer.from(changed.files.get(check.evidence.baselineScreenshot)));
  seal(changed); rejects(changed, 'SOURCE_STABILITY_MISMATCH', 'target');
  const forged = cloneSource(source);
  editDetails(forged, checkOf(forged, 'visual'), 'target', value => { value.stability = 0.9998; });
  seal(forged); rejects(forged, 'SOURCE_STABILITY_MISMATCH', 'target');
});

test('the derived PNG comparison canvas is bounded before either image is decoded', async () => {
  const source = await loadSource(), changed = cloneSource(source), check = checkOf(changed, 'visual');
  for (const [role, width, height] of [['targetScreenshot', 12000, 1000], ['targetRepeat', 1000, 12000]]) {
    const file = check.evidence[role], data = Buffer.from(changed.files.get(file));
    data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20); changed.files.set(file, data);
    assert.ok(width * height <= BROWSER_CANDIDATE_LIMITS_V1.pngPixels);
  }
  assert.ok(12000 * 12000 > BROWSER_CANDIDATE_LIMITS_V1.pngPixels);
  seal(changed);
  // CRCs are intentionally not recomputed. A decoder-first implementation
  // fails as invalid PNG instead of proving the derived allocation was bounded.
  rejects(changed, 'SOURCE_PNG_COMPARISON_BUDGET', 'target');
});

test('duplicate IHDR and unsupported interlaced or sample encodings are rejected without decoding', async () => {
  const source = await loadSource(), file = checkOf(source, 'visual').evidence.targetScreenshot;
  const cases = [
    data => Buffer.concat([data.subarray(0, 33), data.subarray(8, 33), data.subarray(33)]),
    data => { data[28] = 1; return data; },
    data => { data[24] = 16; return data; },
    data => { data[25] = 0; return data; },
  ];
  for (const mutate of cases) {
    const changed = cloneSource(source); changed.files.set(file, mutate(Buffer.from(changed.files.get(file)))); seal(changed);
    const originalRead = PNG.sync.read;
    let decodes = 0;
    PNG.sync.read = () => { decodes++; throw new Error('unsupported PNG must be rejected before decoding'); };
    try { rejects(changed, 'SOURCE_PNG_INVALID', 'target'); }
    finally { PNG.sync.read = originalRead; }
    assert.equal(decodes, 0);
  }
});

test('report expected, source identity and environment are preserved provenance rather than an editable new oracle', async () => {
  const source = await loadSource();
  const cases = [
    changed => { checkOf(changed, 'visual').identity.oracleKey = 'a'.repeat(64); },
    changed => { checkOf(changed, 'visual').identity.ruleKey = 'a'.repeat(64); },
    changed => { checkOf(changed, 'structure').expected.title = 'invented old baseline'; },
    changed => { checkOf(changed, 'visual').expected.minimumScore = 0; },
    changed => { checkOf(changed, 'behavior').expected.assertions[0].passed = false; },
    changed => { changed.snapshot.report.environment.timezoneId = 'UTC'; },
    changed => { changed.snapshot.report.safety.blockedRequests = 1; },
    changed => { changed.snapshot.report.coverage.completed = 27; },
    changed => { changed.snapshot.manifest.status = 'interrupted'; },
    changed => { changed.snapshot.report.baselineUrl += '&changed=1'; },
    changed => { changed.snapshot.report.verifierFingerprint = 'b'.repeat(64); },
  ];
  for (const mutate of cases) {
    const changed = cloneSource(source); mutate(changed); seal(changed); rejects(changed, undefined, 'target');
  }
});

test('exact planned URLs retain query identity while captured final URLs expose only redacted observations', async () => {
  const source = await loadSource(), target = project(source, 'target');
  assert.ok(source.snapshot.manifest.plan.routes.every(route => /revision=/.test(route)));
  assert.equal(target.projection.source.entryUrl, source.snapshot.manifest.plan.targetUrl);
  assert.match(target.preview.urlProof.planned, /exact-normalized-plan/);
  assert.match(target.preview.urlProof.observedFinal, /redacted/);
  for (const observation of target.preview.observations) {
    assert.match(observation.plannedUrl, /revision=/);
    assert.match(observation.observedFinalUrl, /revision=%5Bredacted%5D/);
    assert.equal(observation.finalUrlProof, 'redacted-observation-only');
    assert.equal(new URL(observation.observedFinalUrl).searchParams.get('revision'), '[redacted]');
  }
  const altered = cloneSource(source);
  editDetails(altered, checkOf(altered, 'visual'), 'target', detail => { detail.snapshot.url += '&secret=unredacted'; });
  seal(altered); rejects(altered, 'SOURCE_SNAPSHOT_SEMANTICS_INVALID', 'target');
});

test('verified provenance ignores unreferenced index entries without silently ignoring an actual reference', async () => {
  const source = await loadSource(), original = project(source);
  const extra = cloneSource(source);
  extra.snapshot.report.evidenceManifest.push({ file: 'unread-extra.json', bytes: 999, sha256: 'a'.repeat(64) });
  seal(extra);
  const result = project(extra);
  assert.equal(result.projection.evidenceManifestDigest, original.projection.evidenceManifestDigest);
  assert.equal(result.projection.selectedEvidenceManifestDigest, original.projection.selectedEvidenceManifestDigest);
  assert.equal(result.projection.oracleManifestKey, original.projection.oracleManifestKey);
  assert.notEqual(result.projection.sourceReportDigest, original.projection.sourceReportDigest);
  const missing = cloneSource(source), file = checkOf(missing, 'visual').evidence.targetRepeat;
  missing.snapshot.report.evidenceManifest = missing.snapshot.report.evidenceManifest.filter(entry => entry.file !== file);
  seal(missing); rejects(missing, 'SOURCE_EVIDENCE_NOT_INDEXED');
});

test('strict native data rejects getters, proxies, hooks, shared bytes and malformed options without evaluating them', async () => {
  const source = await loadSource();
  let hooks = 0;
  const snapshot = copy(source.snapshot);
  Object.defineProperty(snapshot, 'report', { enumerable: true, get() { hooks++; throw new Error('getter must not run'); } });
  rejects({ snapshot, files: source.files }, 'SOURCE_SNAPSHOT_INVALID');
  const proxySnapshot = new Proxy(source.snapshot, { get() { hooks++; throw new Error('proxy must not run'); } });
  rejects({ snapshot: proxySnapshot, files: source.files }, 'SOURCE_SNAPSHOT_INVALID');
  rejects({ snapshot: source.snapshot, files: new Proxy(source.files, { get() { hooks++; throw new Error('Map proxy must not run'); } }) }, 'SOURCE_FILES_INVALID');
  rejects({ snapshot: source.snapshot, files: Object.fromEntries(source.files) }, 'SOURCE_FILES_INVALID');
  const ownMap = new Map(source.files); ownMap.get = () => { hooks++; throw new Error('Map hook must not run'); };
  rejects({ snapshot: source.snapshot, files: ownMap }, 'SOURCE_FILES_INVALID');
  const toJSON = copy(source.snapshot); toJSON.toJSON = () => { hooks++; return {}; };
  rejects({ snapshot: toJSON, files: source.files }, 'SOURCE_SNAPSHOT_INVALID');
  const shared = cloneSource(source); shared.files.set('manifest.json', new Uint8Array(new SharedArrayBuffer(1)));
  rejects(shared, 'SOURCE_FILE_BUDGET');
  const ownBytes = cloneSource(source), originalBytes = ownBytes.files.get('manifest.json');
  Object.defineProperty(originalBytes, 'byteLength', { get() { hooks++; throw new Error('byteLength hook must not run'); } });
  Object.defineProperty(originalBytes, 'buffer', { get() { hooks++; throw new Error('buffer hook must not run'); } });
  Object.defineProperty(originalBytes, 'byteOffset', { get() { hooks++; throw new Error('offset hook must not run'); } });
  assert.equal(project(ownBytes).preview.executionReady, false);
  const options = {};
  Object.defineProperty(options, 'sourceSide', { enumerable: true, get() { hooks++; return 'target'; } });
  assert.throws(() => projectBrowserBaselineCandidate(source, options), error =>
    error instanceof AcceptanceCatalogError && error.details?.reason === 'SOURCE_INPUT_INVALID');
  for (const options of [undefined, {}, { sourceSide: 'source' }, { sourceSide: 'target', projectId: 'invented' }]) {
    assert.throws(() => projectBrowserBaselineCandidate(source, options), AcceptanceCatalogError);
  }
  assert.equal(hooks, 0);
});

test('bounded source material rejects oversized files, excessive files and deep snapshot data before projection', async () => {
  const source = await loadSource();
  const deep = cloneSource(source);
  let cursor = deep.snapshot;
  for (let i = 0; i <= BROWSER_CANDIDATE_LIMITS_V1.jsonDepth; i++) cursor = cursor.deep = {};
  rejects(deep, 'SOURCE_SNAPSHOT_INVALID');
  const fileBudget = cloneSource(source);
  fileBudget.files.set('manifest.json', Buffer.alloc(BROWSER_CANDIDATE_LIMITS_V1.jsonBytes + 1));
  rejects(fileBudget, 'SOURCE_FILE_BUDGET');
  const many = cloneSource(source);
  for (let i = 0; i <= BROWSER_CANDIDATE_LIMITS_V1.evidenceFiles + 2; i++) many.files.set(`extra-${i}.json`, Buffer.from('{}'));
  rejects(many, 'SOURCE_FILES_BUDGET');
  assert.equal(Object.isFrozen(BROWSER_CANDIDATE_PROJECTION_V1), true);
  assert.equal(Object.isFrozen(BROWSER_CANDIDATE_LIMITS_V1), true);
  assert.equal(Object.isFrozen(SUPPORTED_BROWSER_VERIFIERS_V1), true);
});

test('full human review preview is rejected over budget instead of truncating a selected control oracle', async () => {
  const source = await loadSource(), changed = cloneSource(source);
  const check = checkOf(changed, 'structure', '/visual-shift', 'desktop');
  // A DOM ID becomes a CSS path without clipping in the source runner. This is
  // bounded raw material but deliberately exceeds the complete review preview.
  const path = '#' + 'p'.repeat(BROWSER_CANDIDATE_LIMITS_V1.previewBytes);
  editDetails(changed, check, 'target', detail => { detail.snapshot.controls[0].path = path; });
  check.actual.controls[0].path = path;
  check.status = 'failed'; check.verdict = 'bug'; check.evaluationLimited = false;
  seal(changed);
  assert.ok(changed.files.get('report.json').length < BROWSER_CANDIDATE_LIMITS_V1.jsonBytes);
  rejects(changed, 'SOURCE_PREVIEW_BUDGET', 'target');
});

test('Browser verifier compatibility is the fixed reviewed legacy and D3 pairs with a pinned source manifest', async () => {
  const reviewed = ['e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8',
    '8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f',
    '2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337',
    '270251e1ca417383ee019a456d1a103ec461c57a9a8c661fdc9ff562cac515f2'];
  assert.deepEqual(SUPPORTED_BROWSER_VERIFIERS_V1, reviewed);
  const names = ['schema.mjs', 'urls.mjs', 'runner.mjs', 'report.mjs', 'spec-schema.mjs',
    'spec-runner.mjs', 'response-schema.mjs', 'openapi.mjs', 'identity.mjs'];
  const sources = await Promise.all([...names.map(file => new URL('../src/acceptance/' + file, import.meta.url)),
    new URL('../src/verify/compare.mjs', import.meta.url)].map(url => readFile(url, 'utf8')));
  const fingerprint = values => sha(values.slice(0, -1).join('\n') + values.at(-1));
  const lf = sources.map(value => value.replaceAll('\r\n', '\n'));
  const manifest = JSON.parse(await readFile(new URL('./fixtures/browser-verifier-reviewed-d3.json', import.meta.url), 'utf8'));
  assert.equal(manifest.reviewedParent, '007760ed80019b4a5369ab284ea7ba734f18d0d2');
  assert.equal(fingerprint(lf), reviewed[2]); assert.equal(manifest.lfFingerprint, reviewed[2]);
  assert.equal(fingerprint(lf.map(value => value.replaceAll('\n', '\r\n'))), reviewed[3]); assert.equal(manifest.crlfFingerprint, reviewed[3]);
  assert.deepEqual(manifest.files, [...names, '../verify/compare.mjs'].map((name, i) => ({ name,
    lfSha256: sha(lf[i]), crlfSha256: sha(lf[i].replaceAll('\n', '\r\n')) })));
  const source = await loadSource('target-unavailable'), original = project(source);
  for (const verifierFingerprint of reviewed) {
    const changed = cloneSource(source); changed.snapshot.report.verifierFingerprint = verifierFingerprint; seal(changed);
    const result = project(changed);
    assert.equal(result.projection.verifierFingerprint, verifierFingerprint);
    assert.equal(result.projection.oracleManifestKey, original.projection.oracleManifestKey);
    assert.equal(result.projection.ruleManifestKey, original.projection.ruleManifestKey);
  }
  for (const unreviewed of ['8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d', 'a'.repeat(64)]) {
    const changed = cloneSource(source); changed.snapshot.report.verifierFingerprint = unreviewed; seal(changed);
    rejects(changed, 'SOURCE_VERIFIER_UNSUPPORTED');
  }
});

test('legacy saved-plan byte fingerprints are distinct from canonical semantic identity', async () => {
  const source = await loadSource('target-unavailable'), initial = project(source);
  const reordered = cloneSource(source);
  reordered.snapshot.manifest.plan = Object.fromEntries(Object.entries(reordered.snapshot.manifest.plan).reverse());
  reordered.snapshot.report.planFingerprint = sha(JSON.stringify(reordered.snapshot.manifest.plan));
  seal(reordered);
  const result = project(reordered);
  assert.notEqual(result.projection.sourcePlanDigest, initial.projection.sourcePlanDigest);
  assert.equal(result.projection.oracleManifestKey, initial.projection.oracleManifestKey);
  assert.equal(result.projection.ruleManifestKey, initial.projection.ruleManifestKey);
  const wrongAlgorithm = cloneSource(reordered);
  wrongAlgorithm.snapshot.report.planFingerprint = hashAcceptanceValue(wrongAlgorithm.snapshot.manifest.plan);
  seal(wrongAlgorithm); rejects(wrongAlgorithm, 'SOURCE_PLAN_DIGEST_MISMATCH');
  const unnormalized = cloneSource(source); unnormalized.snapshot.manifest.plan.normalization.extra = true;
  seal(unnormalized); rejects(unnormalized, 'SOURCE_PLAN_NOT_NORMALIZED');
  const wrongMode = cloneSource(source); wrongMode.snapshot.manifest.mode = 'spec';
  seal(wrongMode); rejects(wrongMode, 'SOURCE_MODE_UNSUPPORTED');
});

test('frozen matrix has side-specific golden identities with explicit Browser domain separation', async () => {
  const source = await loadSource();
  const common = { scopeKey: '2edb9a6bb5ccda1fc5f3891cd3454b1e97ba53869014009e1d8d363a7f045960',
    ruleManifestKey: '4a9875b71bc69f9d9451bd637659d7b699b54cb9a345436e4943288c6085ad20',
    sourcePlanDigest: 'ae7affd226de773fd78f309dcf683111503a0d290c15866cc4ac07d2880a299f',
    sourceReportDigest: '09934b6cefa412a54df08409d572be72e41d2b8ff6648619935a43ee5b28bd38' };
  const golden = {
    baseline: { oracleManifestKey: '96ea3fb244e25335294a3aa12cf8416a975f7804cfba9865250258fc95edc731',
      selectedEvidenceManifestDigest: '47041032c66966530590d06d0df7e303bdc21cee3e7507c2995b42d4e4932fd1',
      contentDigest: '62a5381abd2c9f604bc88d14c641ff833284bf6ac9ad6a4a1e6db1123ba5d103' },
    target: { oracleManifestKey: 'a8ca1887fecfc0e5ac6e7eb00b64f6005c17f413c9945ad6243a6cab462a4842',
      selectedEvidenceManifestDigest: '99a80386302f37e5f23d3057bcc23aefad09ab8bf9cb1c93cc96f6c00f0edfd2',
      contentDigest: 'ecf2a93ccee1719beb31675620eeea16450fe7a4a743078802c4c94a94b7aed5' },
  };
  for (const side of ['baseline', 'target']) {
    const { projection, preview } = project(source, side);
    for (const [key, value] of Object.entries({ ...common, ...golden[side] })) assert.equal(projection[key], value, side + '.' + key);
    const { contentDigest, ...content } = projection;
    assert.equal(contentDigest, hashAcceptanceValue({ ...BROWSER_CANDIDATE_PROJECTION_V1, kind: 'content', value: content }));
    assert.notEqual(contentDigest, hashAcceptanceValue(content), 'Browser domain must bind the content hash');
    assert.equal(preview.rules.length, 28);
    assert.ok(preview.rules.every(item => item.rule.capture.animations === 'disabled'
      && item.rule.capture.caret === 'hide' && item.rule.capture.maxPixels === 12_000_000
      && item.rule.capture.maxHeight === 12_000));
    for (const point of source.snapshot.manifest.plan.points) {
      const rows = preview.rules.filter(item => item.slot.pointId === point.id);
      assert.equal(rows.length, source.snapshot.manifest.plan.viewports.length);
      assert.ok(rows.every(item => JSON.stringify(item.rule.steps) === JSON.stringify(point.steps)
        && JSON.stringify(item.rule.assertions) === JSON.stringify(point.assertions)));
    }

    // Second computation starts from the frozen report's selected raw details
    // and image bytes, without using projector preview/oracle implementations.
    const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
      : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
        : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    const oracles = source.snapshot.report.checks.filter(check => ['visual', 'behavior'].includes(check.identity.facet)).map(check => {
      const viewport = source.snapshot.manifest.plan.viewports.find(item => item.name === check.viewport);
      const point = check.identity.pointId && source.snapshot.manifest.plan.points.find(item => item.id === check.identity.pointId);
      const detail = JSON.parse(source.files.get(check.evidence[side + 'Details']));
      return { slot: { route: check.route, viewport: { width: viewport.width, height: viewport.height },
        ...(point ? { pointId: point.id } : {}) },
      oracle: { kind: 'captured-browser-side', entryUrl: source.snapshot.manifest.plan[side + 'Url'],
        httpStatus: detail.httpStatus, structure: { title: detail.snapshot.title, headings: detail.snapshot.headings, controls: detail.snapshot.controls },
        screenshotSha256: sha(source.files.get(detail.screenshot)),
        ...(point ? { steps: copy(point.steps), assertions: copy(point.assertions), observedAssertions: copy(detail.assertions) } : {}) } };
    }).sort((a, b) => canonical(a.slot) < canonical(b.slot) ? -1 : canonical(a.slot) > canonical(b.slot) ? 1 : 0);
    const independentlyRebuilt = sha(canonical({ projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
      domain: 'heimdall-acceptance-browser-candidate', kind: 'oracle', value: oracles }));
    assert.equal(independentlyRebuilt, golden[side].oracleManifestKey, side + ' independent raw-byte oracle');
  }
});

test('projection uses captured bytes only and does not read/write files or issue fetch requests', async () => {
  const source = await loadSource(), before = beforeSource(source), originalFetch = globalThis.fetch;
  const originals = [], touched = [];
  for (const [object, names] of [[fs, ['readFileSync', 'writeFileSync', 'openSync', 'statSync', 'readdirSync', 'mkdirSync', 'renameSync', 'unlinkSync']],
    [fsPromises, ['readFile', 'writeFile', 'open', 'stat', 'readdir', 'mkdir', 'rename', 'unlink']]]) {
    for (const name of names) {
      originals.push([object, name, object[name]]);
      object[name] = () => { touched.push(name); throw new Error('projector must not perform I/O'); };
    }
  }
  globalThis.fetch = () => { touched.push('fetch'); throw new Error('projector must not request'); };
  syncBuiltinESMExports();
  try {
    const result = project(source, 'target');
    assert.equal(result.preview.executionReady, false);
  } finally {
    for (const [object, name, original] of originals) object[name] = original;
    globalThis.fetch = originalFetch; syncBuiltinESMExports();
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(beforeSource(source), before);
});
