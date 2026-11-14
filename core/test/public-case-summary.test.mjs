import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { invoke } from '../src/agent/registry/invoke.mjs';

const CASE = fileURLToPath(new URL('../../docs/cases/xspark/2026-11-04/', import.meta.url));

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
  assert.equal(env.result.integrity.status, 'consistent');
  const serialized = JSON.stringify(env);
  assert.equal(serialized.includes('findings.json'), false);
  assert.equal(serialized.includes('network.har'), false);
  assert.equal(serialized.includes('session.json'), false);
});

test('public case summary refuses paths outside docs/cases', async () => {
  const env = await invoke('public_case_summary', { casePath: resolve(CASE, '..', '..', '..', '..', 'README.md') }, { client: 'mcp' });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'invalid_args');
});
