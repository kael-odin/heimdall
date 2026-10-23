/**
 * Test-only copies of the historical evidence under `docs/audits/**`.
 *
 * The audit archives are kept for reading, not as a test dependency: only the
 * few subtrees a test or smoke actually opens are copied here, byte for byte,
 * under the same relative path they had below `docs/audits/`. Everything else
 * in `docs/audits` can be pruned without turning a suite red.
 *
 * Every consumer resolves through `evidence()` and asserts existence up front,
 * so removing a fixture fails with "fixture missing: <path>" instead of a bare
 * ENOENT from somewhere inside a reader.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('./audit-evidence/', import.meta.url);

/** Absolute path of a copied fixture, relative to `docs/audits/`. */
export const evidence = rel => fileURLToPath(new URL(rel.replaceAll('\\', '/').replace(/^\/+/, ''), ROOT));

/**
 * Resolve a required fixture and fail loudly when it is not there.
 * Returns the absolute path; callers pass it to readFileSync/cpSync/readdir.
 */
export function required(rel) {
  const path = evidence(rel);
  if (!existsSync(path)) throw new Error('fixture missing: ' + rel + ' (expected at ' + path + ')');
  return path;
}

/** Same guard for providers that only report on a boolean condition. */
export function requireFixture(ok, rel) {
  if (!ok) throw new Error('fixture missing: ' + rel);
}

/** Directory form: throws unless `rel` is an existing directory. */
export function requiredDir(rel) {
  const path = required(rel);
  let isDirectory = false;
  try { isDirectory = statSync(path).isDirectory(); } catch { isDirectory = false; }
  if (!isDirectory) throw new Error('fixture missing: ' + rel + ' is not a directory');
  return path;
}
