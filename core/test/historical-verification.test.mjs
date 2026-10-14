import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditHistoricalVerification, estimateLegacyV2 } from '../src/audit/historical-verification.mjs';
import { run } from '../scripts/audit-historical-verification.mjs';

test('legacy reweighting stays an estimate and rejects incomplete observations', () => {
  const record = { overall: 0.9916, viewports: [
    { name: '375x812', width: 375, sourceHeight: 13926, cloneHeight: 8310, mismatched: 40952 },
    { name: '768x1024', width: 768, sourceHeight: 5198, cloneHeight: 5198, mismatched: 10213 },
    { name: '1440x900', width: 1440, sourceHeight: 3838, cloneHeight: 5710, mismatched: 49528 },
  ] };
  assert.deepEqual({ state: estimateLegacyV2(record).state, overall: estimateLegacyV2(record).overall },
    { state: 'legacy_count_estimate', overall: 0.7296 });
  assert.equal(estimateLegacyV2({ ...record, viewports: record.viewports.slice(0, 2) }).state, 'incomplete_observation');
  assert.equal(estimateLegacyV2({ ...record, scoreVersion: 2 }), null);
  const jobs = { viewports: [
    { name: '375x812', width: 375, sourceHeight: 14742, cloneHeight: 14595, mismatched: 416295 },
    { name: '768x1024', width: 768, sourceHeight: 10901, cloneHeight: 10772, mismatched: 339431 },
    { name: '1440x900', width: 1440, sourceHeight: 9331, cloneHeight: 9194, mismatched: 528977 },
  ] };
  assert.equal(estimateLegacyV2(jobs).overall, 0.9386, 'round only the final weighted result');
});

test('historical audit preserves source files and separates missing query identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-history-audit-'));
  try {
    const site = join(root, 'workspace', 'fixture.test');
    const page = join(site, 'pages', 'docs');
    const out = join(root, 'out');
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(site, 'verify', 'docs'), { recursive: true });
    mkdirSync(join(site, 'recon'), { recursive: true });
    const manifest = join(page, 'manifest.json');
    const source = JSON.stringify({ target: 'https://fixture.test/docs' });
    writeFileSync(manifest, source);
    writeFileSync(join(page, 'clone', 'index.html'), '<h1>fixture</h1>');
    writeFileSync(join(site, 'verify', 'docs', 'verify.json'), JSON.stringify({ overall: 0.99,
      viewports: [{ name: '375x812', width: 375, sourceHeight: 100, cloneHeight: 50, mismatched: 0 }] }));
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://fixture.test', nodes: [
      { url: 'https://fixture.test/docs', type: 'docs' },
      { url: 'https://fixture.test/docs?token=private', type: 'docs' },
    ] }));
    const result = auditHistoricalVerification(join(root, 'workspace'));
    assert.equal(result.summary.forgedPages, 1);
    assert.equal(result.summary.incompleteObservations, 1);
    assert.equal(result.summary.missingAtlasUrls, 1);
    assert.equal(result.summary.coveredAtlasUrls, 1);
    assert.equal(result.summary.missingLegacyCollisions, 1);
    assert.notEqual(result.missing[0].proposedPage, 'docs');
    assert.equal(result.missing[0].queryHash.length, 12);
    assert.equal(JSON.stringify(result).includes('private'), false);
    run({ workspace: join(root, 'workspace'), outDir: out });
    assert.equal(readFileSync(manifest, 'utf8'), source);
    assert.equal(readFileSync(join(out, 'historical-verification-missing.csv'), 'utf8').includes('private'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
