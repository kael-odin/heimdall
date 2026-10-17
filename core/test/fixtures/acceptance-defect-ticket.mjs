/** Two real captured source sides, organized as independent candidate scopes. */
import { browserFixedFixture } from './acceptance-browser-fixed.mjs';
import { buildBrowserCandidateReview } from '../../src/acceptance/browser-candidate-review.mjs';
import { compileFixedBrowserContract } from '../../src/acceptance/browser-fixed-contract.mjs';
import { append, copy, uid } from './acceptance-browser-organized-candidate.mjs';

export async function secondDefectTicketCandidate(f, catalog) {
  const captured = await browserFixedFixture('target'), original = captured.review.organizationContext;
  const release = { ...original.release, id: uid('ar', 9002), projectId: f.project.id };
  const sourceBinding = { ...original.sourceBinding, id: uid('ax', 9003), projectId: f.project.id, releaseId: release.id };
  append(catalog, 'releases', release, 'release-created', f.project.id);
  append(catalog, 'browserSourceBindings', sourceBinding, 'browser-source-bound', f.project.id);
  const review = buildBrowserCandidateReview({ project: f.project, release, sourceBinding, material: captured.material });
  const candidate = { ...captured.candidate, id: uid('bc', 9004), ...copy(review.candidateContent), contentDigest: review.contentDigest };
  append(catalog, 'browserCandidates', candidate, 'browser-candidate-created', f.project.id);
  return { ...captured, project: f.project, sourceBinding, review, candidate, targetRelease: f.targetRelease,
    ...compileFixedBrowserContract({ material: captured.material, review, candidate, targetRelease: f.targetRelease }) };
}
