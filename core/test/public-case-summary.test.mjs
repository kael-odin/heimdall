import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { invoke } from '../src/agent/registry/invoke.mjs';

const CASE = fileURLToPath(new URL('../../docs/cases/xspark/2026-11-04/', import.meta.url));
const CASES = resolve(CASE, '..', '..');

test('public case summary reads the Xspark evidence boundary without raw artifacts', async () => {
  const env = await invoke('public_case_summary', { casePath: CASE }, { client: 'mcp' });
  assert.equal(env.ok, true);
  assert.equal(env.result.schema, 'heimdall.public-case-summary/1');
  assert.equal(env.result.case.id, 'xspark-public-web-qa');
  assert.equal(env.result.coverage.pages, 5);
  assert.equal(env.result.coverage.pageViewportChecks, 10);
  assert.equal(env.result.qa.baseline.gate, 'passed');
  assert.equal(env.result.qa.fileable, 0);
  assert.equal(env.result.qa.findingDigest.status, 'observed');
  assert.equal(env.result.qa.findingDigest.total, 0);
  assert.deepEqual(env.result.qa.findingDigest.items, []);
  assert.equal(env.result.seo.score, 90.8);
  assert.equal(env.result.seo.scoreMethodStatus, 'unknown');
  assert.equal(env.result.seo.measurementStatus, 'unknown');
  assert.equal(env.result.seo.geoMethodStatus, 'unknown');
  assert.equal(env.result.seo.geo.status, 'unknown');
  assert.equal(env.result.seo.geo.score, null);
  assert.deepEqual(env.result.seo.geo.actionPlan, []);
  assert.equal(env.result.capabilities.evidenceStatus, 'missing');
  assert.equal(env.result.capabilities.clone.status, 'unknown');
  assert.equal(env.result.capabilities.independentDeployment.status, 'unknown');
  assert.equal(env.result.capabilities.backendCompletion.status, 'unknown');
  assert.equal(env.result.capabilities.bugDetection.status, 'ready_for_declared_scope');
  assert.equal(env.result.capabilities.seo.status, 'observed');
  assert.equal(env.result.capabilities.geo.status, 'unknown');
  assert.ok(env.result.seo.observedActions.total > 0);
  assert.ok(env.result.seo.observedActions.items.some(item => item.id === 'perf-weight-large'));
  assert.match(env.result.proven[3], /仅历史观察/);
  assert.equal(env.result.integrity.status, 'consistent');
  const serialized = JSON.stringify(env);
  assert.equal(serialized.includes('findings.json'), false);
  assert.equal(serialized.includes('network.har'), false);
  assert.equal(serialized.includes('session.json'), false);
  assert.equal(env.nextActions.at(-1).tool, 'heimdall_site_assessment');
});

test('public case summary projects a sanitized site-assessment capability envelope', async () => {
  const dir = mkdtempSync(join(CASES, '.public-case-summary-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      schema: 'heimdall.public-case/1',
      case: 'fixture',
      project: 'Fixture',
      target: { site: 'fixture.test', origin: 'https://fixture.test', pages: ['/'], viewports: ['1440x900'], writes: 'block' },
    }));
    const evidenceDir = join(dir, 'evidence');
    mkdirSync(evidenceDir);
    writeFileSync(join(evidenceDir, 'site-assessment.json'), JSON.stringify({
      result: {
        siteId: 'fixture.test',
        origin: 'https://fixture.test',
        readiness: {
          clone: { status: 'ready', basis: 'verified', evidence: ['D:\\private\\clone'], closure: {
            schema: 'heimdall.rebuild-closure/1', state: 'open', counts: { required: 5, verified: 4, open: 1, unknown: 0 },
            requiredObligations: [{ id: 'delivery-scope', state: 'open' }, { id: 'private-secret', state: 'verified' }],
          } },
          independentDeployment: { status: 'verified', basis: 'verified' },
          backend: { status: 'needs_human_review', basis: 'observed', closure: {
            schema: 'heimdall.backend-closure/1', state: 'open', counts: { required: 8, verified: 3, open: 0, unknown: 5, notApplicable: 1 },
            requiredObligations: [{ id: 'observed-contract', state: 'unknown' }],
          } },
          seo: { status: 'ready', basis: 'observed', closure: {
            schema: 'heimdall.seo-geo-closure/1', state: 'open', counts: { required: 5, verified: 4, open: 1, unknown: 0 },
            requiredObligations: [{ id: 'optimization-actions', state: 'open' }],
          } },
          geo: { status: 'needs_follow_up', basis: 'observed' },
          qa: { status: 'ready', basis: 'verified', closure: {
            schema: 'heimdall.qa-closure/1', state: 'open', counts: { required: 6, verified: 4, open: 1, unknown: 1 },
            requiredObligations: [{ id: 'business-checks', state: 'open' }],
          } },
        },
      },
    }));
    const env = await invoke('public_case_summary', { casePath: dir }, { client: 'mcp' });
    assert.equal(env.ok, true);
    assert.equal(env.result.integrity.status, 'consistent');
    assert.equal(env.result.capabilities.evidenceStatus, 'observed');
    assert.equal(env.result.capabilities.clone.status, 'ready');
    assert.equal(env.result.capabilities.independentDeployment.status, 'verified');
    assert.equal(env.result.capabilities.backendCompletion.status, 'needs_human_review');
    assert.deepEqual(env.result.capabilities.backendCompletion.closure.counts, { required: 8, verified: 3, open: 0, unknown: 5, notApplicable: 1 });
    assert.deepEqual(env.result.capabilities.seo.closure.requiredObligations, [{ id: 'optimization-actions', state: 'open' }]);
    assert.deepEqual(env.result.capabilities.bugDetection.closure.requiredObligations, [{ id: 'business-checks', state: 'open' }]);
    assert.equal(env.result.capabilities.clone.closure.requiredObligations.some(item => item.id === 'private-secret'), true);
    assert.equal(env.result.capabilities.bugDetection.status, 'ready');
    assert.equal(env.result.capabilities.geo.status, 'needs_follow_up');
    assert.equal(JSON.stringify(env).includes('D:\\private\\clone'), false);
    assert.ok(env.evidence.some(item => item.path.endsWith('/manifest.json')));
    assert.ok(env.evidence.some(item => item.path.endsWith('/evidence/site-assessment.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public case summary refuses paths outside docs/cases', async () => {
  const env = await invoke('public_case_summary', { casePath: resolve(CASE, '..', '..', '..', '..', 'README.md') }, { client: 'mcp' });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'invalid_args');
});
