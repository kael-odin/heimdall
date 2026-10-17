/** Frozen captured source, independently read from the checked-in test fixture. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildBrowserCandidateReview } from '../../src/acceptance/browser-candidate-review.mjs';
import { projectBrowserBaselineCandidate } from '../../src/acceptance/browser-candidate-projection.mjs';
import { compileFixedBrowserContract } from '../../src/acceptance/browser-fixed-contract.mjs';
import { AT, uid, copy } from './acceptance-browser-organized-candidate.mjs';

const ROOT = fileURLToPath(new URL('./acceptance-browser-source/matrix/', import.meta.url));
export async function browserFixedFixture(side = 'baseline') {
  const [manifest, report, integrity] = await Promise.all(['manifest.json', 'report.json', 'integrity.json']
    .map(async file => JSON.parse(await readFile(join(ROOT, file)))));
  const references = [...new Set(report.checks.flatMap(check => Object.values(check.evidence)).filter(value => value !== null))];
  const files = new Map(await Promise.all(['manifest.json', 'report.json', ...references].map(async file => [file, await readFile(join(ROOT, file))])));
  const material = { snapshot: { manifest, report, integrity }, files };
  const projection = projectBrowserBaselineCandidate(material, { sourceSide: side }).projection;
  const project = { id: uid('ap', 701), name: '固定 Browser 验收', createdAt: AT };
  const release = { id: uid('ar', 702), projectId: project.id, label: 'Captured source', targetUrl: projection.source.entryUrl, createdAt: AT };
  const { mode: _mode, contentDigest: sourceContentDigest, ...rest } = projection;
  const sourceBinding = { id: uid('ax', 703), projectId: project.id, releaseId: release.id, ...rest,
    sourceContentDigest, boundAt: AT, actor: { kind: 'local-operator' } };
  const review = buildBrowserCandidateReview({ project, release, sourceBinding, material });
  const candidate = { id: uid('bc', 704), ...copy(review.candidateContent), contentDigest: review.contentDigest,
    createdAt: AT, actor: { kind: 'local-operator' } };
  const targetRelease = { id: uid('ar', 705), projectId: project.id, label: 'New target', targetUrl: 'https://fixed-target.test/application?release=one', createdAt: AT };
  const input = { material, review, candidate, targetRelease };
  return { ...input, ...compileFixedBrowserContract(input) };
}
