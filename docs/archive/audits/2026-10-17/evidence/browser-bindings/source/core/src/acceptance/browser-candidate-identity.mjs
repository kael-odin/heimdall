/** Frozen Browser projection digests; independent of catalog, PNG and I/O. */
import { hashAcceptanceValue } from './identity.mjs';

export const BROWSER_CANDIDATE_PROJECTION_V1 = Object.freeze({
  projectionVersion: 1, canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
  domain: 'heimdall-acceptance-browser-candidate',
});

export function hashBrowserCandidateValue(kind, value) {
  return hashAcceptanceValue({ ...BROWSER_CANDIDATE_PROJECTION_V1, kind, value });
}
