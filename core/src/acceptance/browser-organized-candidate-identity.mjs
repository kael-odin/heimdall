/** Frozen organized Browser candidate digests; no catalog, source or I/O access. */
import { hashAcceptanceValue } from './identity.mjs';

export const BROWSER_ORGANIZED_CANDIDATE_V1 = Object.freeze({
  candidateContractVersion: 1, canonicalJsonVersion: 'acceptance-json-v1', digestAlgorithm: 'sha256',
  domain: 'heimdall-acceptance-browser-organized-candidate',
});

export function hashOrganizedBrowserCandidateValue(kind, value) {
  return hashAcceptanceValue({ ...BROWSER_ORGANIZED_CANDIDATE_V1, kind, value });
}
