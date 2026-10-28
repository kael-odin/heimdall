import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceRunView } from '../src/acceptance/run-view.mjs';

test('managed console views retain lifecycle diagnostics without exposing stored paths, secrets or dispatch material', () => {
  for (const status of ['failed', 'interrupted']) {
    const manifest = { runId: 'ac-fixture', status, gate: 'blocked', reasonCode: 'ENGINE_RESTARTED',
      error: 'ENOENT C:\\private\\credentials.json SECRET_TOKEN', plan: { credential: 'SECRET_TOKEN' },
      envelope: { nonce: 'PRIVATE_NONCE' }, receipt: { bytes: 'PRIVATE_BYTES' },
      managed: { projectId: 'ap-fixture', target: { releaseId: 'ar-target' }, source: { runId: 'ac-source' },
        operationId: 'PRIVATE_OPERATION', dispatchSha256: 'PRIVATE_DISPATCH' } };
    const view = acceptanceRunView(manifest, { includePlan: true });
    assert.equal(view.status, status); assert.equal(view.reasonCode, 'ENGINE_RESTARTED');
    assert.match(view.error, /现场已保留/); assert.equal(view.triageSupported, false);
    assert.deepEqual(view.provenance, { kind: 'managed-spec', projectId: 'ap-fixture', targetReleaseId: 'ar-target', sourceRunId: 'ac-source' });
    assert.doesNotMatch(JSON.stringify(view), /SECRET|PRIVATE|credentials|C:\\/);
    assert.equal(view.localizationAvailable, false);
    assert.deepEqual(Object.keys(view).sort(), ['runId', 'status', 'gate', 'reasonCode', 'error', 'provenance', 'triageSupported', 'triageAvailable', 'localizationAvailable'].sort());
  }
});

test('legacy detail still restores its declared Spec plan while list views omit it', () => {
  const manifest = { runId: 'ac-legacy', status: 'completed', plan: { mode: 'spec' }, unknownPrivate: 'not-a-view-field' };
  assert.deepEqual(acceptanceRunView(manifest), { runId: manifest.runId, status: manifest.status });
  assert.deepEqual(acceptanceRunView(manifest, { includePlan: true }), { runId: manifest.runId, status: manifest.status, plan: manifest.plan });
});
