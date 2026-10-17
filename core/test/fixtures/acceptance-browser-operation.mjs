/** Offline schema/store fixture; no browser or network is launched. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';
import { createBrowserOperationStore } from '../../src/acceptance/browser-operation-store.mjs';
import { fixedBrowserCheckIdentity, fixedBrowserEnvironmentComparison } from '../../src/acceptance/browser-fixed-contract.mjs';
import { browserFixedFixture } from './acceptance-browser-fixed.mjs';
import { copy, uid } from './acceptance-browser-organized-candidate.mjs';

export async function browserOperationFixture(t) {
  const f = await browserFixedFixture(), root = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-browser-operation-')));
  const owner = acquireAcceptanceOwner({ root }), store = createBrowserOperationStore({ owner });
  t.after(() => { owner.release(); rmSync(root, { recursive: true, force: true }); });
  const { project, sourceBinding } = f.review.organizationContext;
  const request = () => ({ operationId: 'bo-' + randomUUID(), expectedGenerationId: uid('ag', 901), expectedRevision: 4,
    candidateId: f.candidate.id, contentDigest: f.candidate.contentDigest, targetReleaseId: f.targetRelease.id });
  const publish = (input = request(), options) => store.publish({ ...f, project, sourceBinding, request: input }, options);
  return { ...f, root, owner, store, project, sourceBinding, request, publish };
}

export function browserOperationRaw(f, run, { bug = false, environment = f.contract.fixedBaseline.sourceEnvironment } = {}) {
  const contract = f.contract, written = new Set(), write = (file, bytes) => {
    if (!written.has(file)) { writeFileSync(join(run.outputDir, file), bytes, { flag: 'wx' }); written.add(file); }
  };
  const checks = contract.scope.map((scope, index) => {
    const { facet, ...slot } = scope;
    const observation = contract.observations.find(v => JSON.stringify(v.slot) === JSON.stringify(slot));
    const selected = observation.evidence, evidence = {
      baselineScreenshot: 'source-' + selected.screenshot.file, baselineDetails: 'source-' + selected.details.file,
      baselineRepeat: 'source-' + selected.repeat.file, targetScreenshot: 'target-' + selected.screenshot.file,
      targetDetails: 'target-' + selected.details.file, targetRepeat: 'target-' + selected.repeat.file,
    };
    for (const role of ['screenshot', 'details', 'repeat']) write('target-' + selected[role].file, f.sourceFiles.get(selected[role].file));
    if (facet === 'visual') { evidence.diff = 'diff-' + selected.screenshot.file; write(evidence.diff, f.sourceFiles.get(selected.screenshot.file)); }
    return { id: 'check-' + index, route: slot.route, viewport: observation.viewportName,
      identity: fixedBrowserCheckIdentity(contract, environment, slot, facet), title: 'Offline operation check ' + index,
      dimension: ['visual', 'structure', 'behavior'].includes(facet) ? facet : 'health',
      status: bug && index === 0 ? 'failed' : 'passed', verdict: bug && index === 0 ? 'bug' : 'match',
      actual: { eligible: true, stepsComplete: true, assertions: [] }, evidence, evaluationLimited: false };
  });
  return { schemaVersion: 1, runId: run.runId, name: contract.plan.name, mode: 'browser-fixed',
    baselineUrl: contract.fixedBaseline.entryUrl, targetUrl: contract.targetUrl, targetReleaseId: contract.targetReleaseId,
    fixedBaseline: copy(contract.fixedBaseline), contractDigest: contract.contractDigest,
    sourceEvidence: copy(contract.sourceEvidence), resolution: { kind: 'observation-only', closesBugs: false },
    environment: copy(environment), environmentComparison: fixedBrowserEnvironmentComparison(contract, environment),
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'completed', checks,
    coverage: { planned: contract.scope.length, completed: checks.length, capped: false },
    safety: { networkPolicy: 'read-only', isolatedContexts: true, blockedRequests: 0 }, scope: 'Offline declared fixture slots only.' };
}
