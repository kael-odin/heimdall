export { decideDetectorExpansion } from '../src/qa/metrics.mjs';

export function matchesFrozenBatch(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== 20 || expected.length !== 20) return false;
  const keys = rows => rows.map(row => {
    const parts = [row?.cohort, row?.site, row?.runId];
    return parts.every(part => typeof part === 'string' && part.length > 0) ? JSON.stringify(parts) : null;
  });
  const expectedKeys = keys(expected);
  const actualKeys = keys(actual);
  const frozen = new Set(expectedKeys);
  return !frozen.has(null) && frozen.size === 20 && new Set(actualKeys).size === 20
    && actualKeys.every(key => frozen.has(key));
}
